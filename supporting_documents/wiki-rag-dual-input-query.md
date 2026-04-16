# Wiki + RAG Dual-Input Query — TypeScript Implementation

## What each layer contributes to the answer

| | Wiki synthesis | RAG chunks |
|---|---|---|
| Role | Compiled knowledge layer | Ground-truth verification layer |
| Provides | Cross-references, contradiction flags, version history, confidence, related topics, supersession tracking | Exact wording, specific numbers, legal citations, current raw text |
| When it's better | Questions spanning multiple docs, "what's our policy on X", historical context, "how has X changed" | "What exact number does the policy state", "quote the relevant clause", verification of wiki claims |
| Updated | At ingest time (when doc syncs to S3) | Via Bedrock Knowledge Base (AWS-managed OpenSearch Serverless) |
| Failure mode | Could be stale if source changed since last ingest | Chunks may be fragmented or miss cross-doc relationships |

**Architecture**: Bedrock Knowledge Bases uses a managed OpenSearch Serverless collection internally. The retrieval API is the `RetrieveCommand` from `@aws-sdk/client-bedrock-agent-runtime` (TypeScript/Node.js). The wiki (this compartment system) acts as the navigation layer; the KB acts as the ground truth index.

**Together**: Wiki gives Claude the map; RAG gives Claude the ground truth.
Claude uses both in the same inference call.

---

## The Complete Hybrid Query Flow

The hybrid query combines wiki navigation with KB retrieval in six steps:

### Step 1: Search the wiki index for relevant pages

The wiki maintains an `index.md` with one-line summaries of every page. A small LLM pre-pass reads the index and identifies the 3-7 most relevant wiki pages to consult.

**TypeScript**:
```typescript
const index = await this.store.readIndex();
const relevantPaths = await this.client.searchWikiIndex(question, index);
// Returns ["entities/gandalf.md", "concepts/istari.md"]
```

Cost: ~$0.001 per query (index.md is small). Degrades gracefully to broad KB search if no pages are identified.

### Step 2: Read wiki pages and extract source pointers

For each relevant wiki page, read the full content, parse the YAML frontmatter, and extract the `sources:` list. These source pointers contain the S3 keys needed to route targeted KB retrieval.

**TypeScript**:
```typescript
for (const relPath of relevantPaths) {
  const raw = await this.store.readWikiPage(relPath);
  const parsed = parseWikiFrontmatter(relPath, raw);
  
  // parsed.frontmatter.sources = [
  //   { s3_key: "tolkien/raw/silmarillion.pdf", 
  //     file_path: "silmarillion.pdf",
  //     sections: ["Chapter 1"],
  //     hash: "abc123..." }
  // ]
  
  allSourcePointers.push(...parsed.frontmatter.sources);
  wikiPagesUsed.push(relPath);
}
```

### Step 3: Targeted KB retrieval (or broad fallback)

If source pointers were extracted, use them to filter KB retrieval to specific source files (targeted). If no wiki coverage, fall back to broad semantic search across all KB documents.

**TypeScript**:
```typescript
if (allSourcePointers.length > 0) {
  // Targeted: KB returns chunks from files mentioned in wiki pages
  ragChunks = await kb.retrieveTargeted({
    knowledgeBaseId,
    query: question,
    filter: { s3Key: ptr.s3_key }  // filters KB by source file
  });
  method = "wiki_guided";
} else {
  // Broad fallback: semantic search across entire KB
  ragChunks = await kb.retrieveBroad({
    knowledgeBaseId,
    query: question
  });
  method = "rag_fallback";
}
```

### Step 4: Format dual context blocks

Build two labelled sections: wiki synthesis (top, 60% of context budget) and RAG excerpts (bottom, 40%). Gracefully handles missing sections.

**TypeScript**:
```typescript
const maxChars = config.hybridMaxChars;
const wikiBudget = Math.floor(maxChars * 0.6);
const ragBudget = maxChars - wikiBudget;

let wikiContext = wikiPages.join("\n\n");
if (wikiContext.length > wikiBudget) {
  wikiContext = wikiContext.slice(0, wikiBudget) + "\n[... truncated ...]";
}

let ragContext = "";
for (const chunk of ragChunks) {
  const entry = `[Source: ${chunk.s3Key}, Section ${chunk.location.sectionHeader}]\n${chunk.content}\n`;
  if (ragContext.length + entry.length > ragBudget) break;
  ragContext += entry;
}
```

### Step 5: Compose Bedrock/Anthropic call with system prompt + messages

The system prompt (separate from the user message) governs how Claude should use both input streams: when to cite, how to handle contradictions, when to surface staleness warnings.

**TypeScript**:
```typescript
const result = await this.client.hybridQuery({
  question,
  wikiContext,
  ragContext,
  method,
  orgName: "My Organization",
  history: [/* optional prior conversation turns */]
});
// Calls: { system: HYBRID_SYSTEM_PROMPT, messages: [...history, userMsg] }
```

### Step 6: Return structured result

```typescript
{
  answer: "...",
  method: "wiki_guided" | "rag_fallback",
  wikiPagesUsed: ["entities/gandalf.md"],
  sourcesConsulted: ["tolkien/raw/silmarillion.pdf"],
  stalenessWarnings: [/* if KB sources changed since wiki ingest */],
  pagesUpserted: [/* if synthesis persisted to wiki */]
}
```

---

## System Prompt: Governing Citation and Confidence

The `HYBRID_SYSTEM_PROMPT` controls how Claude uses both input streams:

```
You are an internal knowledge assistant.
You answer questions using two types of context provided below.

## Context types

WIKI SYNTHESIS — compiled, cross-referenced knowledge pages maintained by an
automated system. Use these for:
- Overview and synthesized understanding
- Cross-references between topics
- Contradiction flags between documents
- Version tracking (which document supersedes which)
- Confidence assessments
- Historical context and evolution of policies/decisions

SOURCE EXCERPTS — raw text extracted from original source files. Use these for:
- Exact wording and direct quotes
- Specific numbers, dates, and thresholds
- Legal and regulatory citations
- Current data (may be newer than wiki synthesis)

## Rules

1. Draw on BOTH wiki synthesis and source excerpts in every answer.
   The wiki gives you the big picture; the sources give you precision.

2. ALWAYS cite the source file path for every factual claim.
   Format: [Source: file_path, Section/Page X] for RAG claims.
   Format: [[WikiPageName]] for wiki-sourced claims.

3. If the wiki flagged a CONTRADICTION between sources, surface it.
   The user needs to know when documents disagree.

4. If a source excerpt contains information NOT in the wiki synthesis,
   include it and note: "Additional detail from source not yet in wiki."

5. If the wiki synthesis mentions information not present in source excerpts,
   still include it but note: "Per wiki synthesis — verify against source for current wording."

6. When the wiki marks a document as SUPERSEDED, do not cite the old version
   unless the user specifically asks about history.

7. End every answer with:
   - Confidence: HIGH / MEDIUM / LOW
   - Sources consulted (list of file paths)
   - Related wiki topics (if any)
```

---

## Python Reference Equivalent

For comparison, here is the Python version of `hybrid_query()` (maintained for reference only — production code is TypeScript/Node.js):

```python
import boto3
import json
import yaml
from typing import Optional

bedrock = boto3.client("bedrock-runtime")

def hybrid_query(user_question: str, conversation_history: list = None, org_name: str = "the organization") -> dict:
    """
    Full hybrid query: wiki informs + routes, RAG retrieves, both feed Bedrock.
    """
    # Step 1: Search wiki for relevant pages
    wiki_hits = search_wiki_index(user_question)

    # Step 2: Read full wiki pages + extract pointers
    wiki_context = ""
    source_pointers = []
    wiki_pages_used = []
    if wiki_hits:
        for hit in wiki_hits:
            page = read_wiki_page(hit["wiki_path"])
            if page:
                wiki_context += f"\n\n{'='*60}\nWIKI PAGE: {page['title']}\n"
                wiki_context += f"Updated: {page['updated']} | Confidence: {page['confidence']}\n"
                wiki_context += f"{'='*60}\n{page['body']}"
                source_pointers.extend(page["sources"])
                wiki_pages_used.append(hit["wiki_path"])

    # Step 3: Targeted RAG fetch using wiki pointers
    if source_pointers:
        rag_chunks = targeted_rag_fetch(source_pointers)
    else:
        rag_chunks = broad_rag_fetch(user_question)

    # Step 4: Format RAG chunks with source paths
    rag_context = ""
    for chunk in rag_chunks:
        location = ""
        if chunk.get("section_id"):
            location = f", Section {chunk['section_id']}"
        elif chunk.get("page_number"):
            location = f", Page {chunk['page_number']}"
        rag_context += f"\n[Source: {chunk.get('s3_key', 'unknown')}{location}]\n{chunk.get('content', '')}\n"

    # Step 5: Compose the Bedrock prompt with BOTH inputs
    user_message = f"""Answer this question using the wiki synthesis and source excerpts below.

QUESTION: {user_question}

{'='*60}
WIKI SYNTHESIS (compiled knowledge — use for overview, cross-references, contradiction flags):
{'='*60}
{wiki_context if wiki_context else "(No wiki coverage for this topic)"}

{'='*60}
SOURCE EXCERPTS (original document text — use for exact wording and verification):
{'='*60}
{rag_context if rag_context else "(No source excerpts retrieved)"}
"""

    messages = []
    if conversation_history:
        messages.extend(conversation_history)
    messages.append({"role": "user", "content": user_message})

    # Step 6: Call Bedrock
    response = bedrock.invoke_model(
        modelId="anthropic.claude-sonnet-4-20250514-v1:0",
        contentType="application/json",
        body=json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 4096,
            "system": SYSTEM_PROMPT.format(org_name=org_name),
            "messages": messages
        })
    )

    result = json.loads(response["body"].read())
    return {
        "answer": result["content"][0]["text"],
        "method": "wiki_guided" if wiki_context else "rag_fallback",
        "wiki_pages": wiki_pages_used
    }
```


## Parsing Wiki Pages — TypeScript

Wiki pages are stored as markdown with YAML frontmatter. The parser must extract the structured `sources:` block to enable targeted KB retrieval.

**TypeScript** (from `store.ts`):
```typescript
export function parseWikiFrontmatter(
  relativePath: string,
  rawContent: string
): ParsedWikiPage {
  // Split on --- delimiters
  if (!rawContent.startsWith("---")) {
    return { relativePath, frontmatter: { sources: [] }, body: rawContent };
  }

  const closeIdx = rawContent.indexOf("\n---", 3);
  if (closeIdx === -1) {
    return { relativePath, frontmatter: { sources: [] }, body: rawContent };
  }

  const yamlBlock = rawContent.slice(3, closeIdx).trim();
  const body = rawContent.slice(closeIdx + 4).trim();
  const frontmatter = parseYamlFrontmatter(yamlBlock);  // simple regex-based parser

  return { relativePath, frontmatter, body };
}

// Returns:
// {
//   relativePath: "entities/gandalf.md",
//   frontmatter: {
//     title: "Gandalf",
//     updated: "2026-04-08",
//     confidence: "HIGH",
//     sources: [
//       {
//         s3_key: "tolkien/raw/silmarillion.pdf",
//         file_path: "silmarillion.pdf",
//         sections: ["Chapter 1: The Music of the Ainur"],
//         pages: [5, 6, 7],
//         hash: "abc123..."
//       }
//     ],
//     related: ["Istari", "Shire"],
//     supersedes: []
//   },
//   body: "Markdown content after frontmatter..."
// }
```

**Usage in hybrid query** (from `engine.ts`):
```typescript
const raw = await this.store.readWikiPage(relPath);
const parsed = parseWikiFrontmatter(relPath, raw);
// Now use parsed.frontmatter.sources to route KB retrieval
allSourcePointers.push(...parsed.frontmatter.sources);
```

---

## Searching the Wiki Index — LLM Pre-Pass Approach

Rather than maintaining a separate vector index over wiki pages, the system performs a small LLM pre-pass against `index.md` (which is already maintained by the ingest pipeline and contains one-line summaries of every wiki page).

**Design rationale**:
- `index.md` is small and already exists — no second index to maintain
- Leverages model's reading comprehension rather than embedding similarity
- Cost: ~$0.001 per query
- Degrades gracefully: if no pages identified, falls back to broad KB search

**TypeScript** (from `client.ts`):
```typescript
async searchWikiIndex(question: string, indexContent: string): Promise<string[]> {
  const prompt = `Given this wiki index and a user question, return the 3-7 most relevant page paths.

Return ONLY a JSON array like: ["entities/page1.md", "concepts/page2.md"]
Return [] if no pages are relevant.

WIKI INDEX:
${indexContent}

USER QUESTION:
${question}`;

  const raw = await this.call(prompt, config.queryModel, 512);
  try {
    const cleaned = raw.trim().replace(/^```.*?\n/, "").replace(/\n```$/, "");
    return JSON.parse(cleaned);
  } catch {
    return [];  // Graceful degradation
  }
}
```

**Usage**:
```typescript
const index = await this.store.readIndex();
const relevantPaths = await this.client.searchWikiIndex(question, index);
// Returns ["entities/gandalf.md", "concepts/istari.md"] or []
```
```

---

## What each part contributes to the output

Example question: "What happens if an employee requests deletion of their data?"

### Without wiki (RAG only)
RAG returns 10 chunks. Some from the retention policy, some from the GDPR
handbook, some from an old HR procedures doc. Claude pieces together a
fragmented answer. Misses that the retention policy supersedes the HR doc.
Doesn't mention the contradiction in backup schedules. Doesn't cross-reference
the compliance audit timeline.

### With wiki + RAG (hybrid)
Wiki provides:
- "Employee data retention: employment + 6 years" (synthesized)
- "GDPR Article 17 erasure requests must respect retention obligations" (cross-ref)
- "Retention policy v3 supersedes v2 and HR procedures doc section 4.2" (version tracking)
- "CONTRADICTION: backup schedule doesn't align" (pre-flagged)
- "Related: [[Compliance framework]] — annual audit checks retention compliance" (cross-ref)

RAG provides (targeted by wiki pointers):
- Exact policy text from Section 2.2 with legal citations
- Exact GDPR handbook text from Page 13 with the 30-day response requirement
- The specific backup schedule entry

Claude fuses both into a comprehensive answer that:
1. States the policy clearly (from wiki synthesis)
2. Quotes the exact legal language (from RAG chunks)
3. Flags the backup contradiction (from wiki)
4. Cross-references the compliance audit schedule (from wiki)
5. Cites every AD file path (from RAG chunk metadata)

---

## Token / Character Budget Management

With both wiki pages and RAG chunks in the prompt, manage the context window carefully.
Claude Sonnet on Bedrock has a 200K token context. The default budget is 60,000 characters 
(roughly 15,000 tokens, well within the 200K limit) split 60% wiki / 40% RAG.

**TypeScript** (from `engine.ts`):
```typescript
function budgetContext(
  wikiSections: string[],
  ragChunks: KbChunk[],
  maxChars = config.hybridMaxChars  // default 60,000
): { wikiContext: string; selectedChunks: KbChunk[] } {
  const wikiBudget = Math.floor(maxChars * 0.6);     // 36,000 chars
  const ragBudget = maxChars - wikiBudget;           // 24,000 chars

  // Assemble wiki context
  let wikiContext = wikiSections.join("\n\n");
  if (wikiContext.length > wikiBudget) {
    wikiContext = wikiContext.slice(0, wikiBudget) + "\n[... wiki context truncated for budget ...]";
  }

  // Select RAG chunks within budget (RAG can use wiki's surplus)
  const effectiveRagBudget = ragBudget + Math.max(0, wikiBudget - wikiContext.length);
  let charsUsed = 0;
  const selectedChunks = ragChunks.filter(chunk => {
    if (charsUsed + chunk.content.length > effectiveRagBudget) return false;
    charsUsed += chunk.content.length;
    return true;
  });

  return { wikiContext, selectedChunks };
}
```

**For exact token counting** (future enhancement):
```typescript
import { BedrockRuntimeClient, CountTokensCommand } from "@aws-sdk/client-bedrock-runtime";

const bedrockClient = new BedrockRuntimeClient({ region: config.region });
const counted = await bedrockClient.send(
  new CountTokensCommand({
    modelId: config.queryModel,
    body: JSON.stringify({ messages: [...] })
  })
);
// counted.inputTokenCount gives exact count
```

Character-based budgeting is conservative: 1 token ≈ 3-4 English prose characters.

---

## Staleness Detection: When Wiki and RAG Disagree

The system prompt instructs Claude to flag when wiki and source excerpts conflict.
The system also detects staleness programmatically by comparing file hashes.

**TypeScript** (from `engine.ts`):
```typescript
function detectStaleness(
  allSourcePointers: WikiSourcePointer[],
  ragChunks: KbChunk[]
): string[] {
  const warnings: string[] = [];
  
  for (const ptr of allSourcePointers) {
    if (!ptr.hash) continue;
    
    const matchingChunk = ragChunks.find(c => c.s3Key === ptr.s3_key);
    if (matchingChunk?.sourceHash && matchingChunk.sourceHash !== ptr.hash) {
      warnings.push(
        `Source has changed since wiki was compiled: ${ptr.file_path} ` +
        `(wiki hash: ${ptr.hash.slice(0, 8)}..., current: ${matchingChunk.sourceHash.slice(0, 8)}...)`
      );
    }
  }
  
  return warnings;
}
```

When staleness is detected, the warnings are appended to the wiki context block:
```
STALENESS WARNING: The following source files have changed since the wiki was
last compiled. Trust the source excerpts over wiki synthesis for these files:
- silmarillion.pdf (modified since wiki update)
```

**KB Metadata Configuration** (AWS setup):
To enable hash-based staleness detection, configure the Bedrock Knowledge Base metadata 
mapping to capture the `x-amz-meta-sha256` custom metadata attribute. This attribute 
should be set on S3 objects during the ingest pipeline's source file writes:

```typescript
// In the ingest pipeline, when writing source file to S3:
await s3.putObject({
  Bucket: bucket,
  Key: s3Key,
  Body: fileContent,
  Metadata: {
    "sha256": sourceFile.sha256  // The hash from the ingest SHA-256 field
  }
});
```

The KB will automatically extract this metadata during sync, making it available 
in `chunk.sourceHash` for staleness checks.

---

## Structured `sources:` Frontmatter for Wiki Pages

Entity and concept pages must declare structured source pointers in their YAML frontmatter.
This enables targeted KB retrieval: the wiki points to which raw documents are relevant,
and those pointers route the KB search.

**Example frontmatter** (after ingest):
```yaml
---
tags: [entity]
type: character
aliases: [Mithrandir, Olórin, The Grey Pilgrim]
title: Gandalf
updated: 2026-04-08
confidence: HIGH
sources:
  - s3_key: tolkien/raw/silmarillion.pdf
    file_path: silmarillion.pdf
    sections: ["Chapter 1: The Music of the Ainur", "Appendix: The Valar"]
    pages: [5, 6, 48]
    hash: abc123def456...
  - s3_key: tolkien/raw/the-lord-of-the-rings.pdf
    file_path: the-lord-of-the-rings.pdf
    sections: ["Book I: Fellowship of the Ring", "Book III: Return of the King"]
    pages: [15, 16, 300, 301]
    hash: xyz789uvw012...
related: [Istari, Saruman, Sauron, Frodo Baggins]
supersedes: []
---
```

**How it's generated**: The `INGEST_PROMPT` in `client.ts` instructs Claude to emit 
this structured frontmatter for every entity and concept page created or updated. 
The `s3_key`, `file_path`, and `hash` values are provided in the ingest prompt from 
the source file metadata, and the model includes them as-is in the frontmatter.

**Graceful degradation**: If a wiki page lacks `sources:` frontmatter (e.g., pages 
created before this system was deployed), the hybrid query falls back to broad KB 
semantic search for that topic — no data loss, just broader retrieval.

---

## Module Map: TypeScript Architecture

| Concept | Location | Responsibility |
|---|---|---|
| Wiki index navigation (LLM pre-pass) | `WikiClient.searchWikiIndex()` in `client.ts` | Identify relevant wiki pages from `index.md` |
| Wiki page parsing | `parseWikiFrontmatter()` in `store.ts` | Extract YAML frontmatter + body + source pointers |
| KB targeted retrieval | `KnowledgeBaseClient.retrieveTargeted()` in `kb.ts` | Query KB filtered by wiki source pointers |
| KB broad fallback | `KnowledgeBaseClient.retrieveBroad()` in `kb.ts` | Semantic search when no wiki coverage |
| Hybrid orchestration | `WikiEngine.hybridQuery()` in `engine.ts` | Sequence: index → pages → KB → context → LLM |
| Dual-input inference | `WikiClient.hybridQuery()` in `client.ts` | Call Anthropic/Bedrock with `{system, messages}` |
| Multi-turn history | `ConversationMessage[]` in `client.ts` | Thread conversation across turns |
| Lambda entry | `hybrid_query` action in `lambda.ts` | AWS Lambda direct invocation handler |
| CLI command | `hybrid-query` in `index.ts` | Local development: `npx tsx index.ts hybrid-query "question"` |

---

## Multi-Turn Conversation

The hybrid query supports conversation history, allowing Claude to maintain context 
across multiple turns. The `ConversationMessage[]` array is passed through the system 
and appended to the Bedrock/Anthropic messages array.

**TypeScript**:
```typescript
interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

// Maintain history across turns
const history: ConversationMessage[] = [];

// Turn 1
const result1 = await engine.hybridQuery(
  "What is our data retention policy?",
  kbId,
  { history }
);
history.push({ role: "user", content: "What is our data retention policy?" });
history.push({ role: "assistant", content: result1.answer });

// Turn 2: Claude now sees turn 1 context
const result2 = await engine.hybridQuery(
  "Does it apply to contractors too?",
  kbId,
  { history }
);
history.push({ role: "user", content: "Does it apply to contractors too?" });
history.push({ role: "assistant", content: result2.answer });
```

**Conversation state**: This system does NOT provide persistence. The caller is 
responsible for maintaining the `history[]` array across API calls. For production 
systems, store conversation history in DynamoDB or a similar store.

---

## Setting Up the Bedrock Knowledge Base

Before hybrid queries work, a Bedrock Knowledge Base must be created that mirrors 
the raw source documents. Here are the setup steps:

### 1. Create the Knowledge Base
Use the Bedrock console or infrastructure-as-code:
```bash
aws bedrock-agent create-knowledge-base \
  --name "wiki-sources" \
  --role-arn "arn:aws:iam::ACCOUNT:role/BedrockKBRole" \
  --knowledge-base-configuration type=VECTOR \
  --storage-configuration type=OPENSEARCH_SERVERLESS
```

### 2. Configure the S3 Data Source
Point the KB at the `{compartment}/raw/` prefix in the same S3 bucket where 
compartments are stored:
```bash
aws bedrock-agent create-data-source \
  --knowledge-base-id <KB_ID> \
  --name "raw-documents" \
  --data-source-configuration \
    type=S3,\
    s3BucketArn="arn:aws:s3:::your-bucket",\
    inclusionPatterns=["compartments/*/raw/*"]
```

### 3. Choose an Embedding Model
The KB needs an embedding model to vectorize document chunks. Options:
- **Amazon Titan Embeddings v2** (recommended, AWS-native)
- Cohere Embed English v3

### 4. Trigger Initial Sync
After data source configuration, start an ingestion job:
```bash
aws bedrock-agent start-ingestion-job \
  --knowledge-base-id <KB_ID> \
  --data-source-id <DATA_SOURCE_ID>
```

This can take 5-30 minutes depending on total document size.

### 5. Set Environment Variable
```bash
export BEDROCK_KB_ID=<KB_ID>
```

Or inject into Lambda environment via CloudFormation/CDK.

### 6. IAM Permissions
The execution role (Fargate task role, Lambda execution role) needs:
```json
{
  "Effect": "Allow",
  "Action": ["bedrock:Retrieve", "bedrock:RetrieveAndGenerate"],
  "Resource": "arn:aws:bedrock:*:ACCOUNT:knowledge-base/*"
}
```

Plus S3 `GetObject` on the raw prefix:
```json
{
  "Effect": "Allow",
  "Action": ["s3:GetObject"],
  "Resource": "arn:aws:s3:::your-bucket/compartments/*/raw/*"
}
```

### 7. Sync After Each Ingest
After running the ingest pipeline, manually trigger a KB sync to index new documents:
```bash
aws bedrock-agent start-ingestion-job --knowledge-base-id <KB_ID> --data-source-id <ID>
```

(Future: automate this with a Lambda post-ingest hook.)
