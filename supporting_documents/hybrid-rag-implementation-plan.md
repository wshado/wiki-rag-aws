# Hybrid Wiki + RAG Implementation Plan

Complete implementation plan for integrating wiki compartments with a pre-existing RAG system via Bedrock Knowledge Bases.

**Status**: Plan only — no code changes yet. This document is for future reference when implementing the TypeScript changes.

---

## Overview

The WikiRAGObsidian system builds a compiled wiki from raw documents. A separate pre-existing RAG system (S3-backed, potentially via Bedrock Knowledge Bases) holds the raw documents. The hybrid query pattern:
- **Wiki** = navigation layer + synthesized knowledge (cross-refs, contradictions, version history, confidence)
- **RAG** = ground truth layer (exact wording, numbers, citations, current text)
- **Hybrid query** = both sent to Claude in a single inference call

---

## Architecture

```
User question
    │
    ▼
WikiClient.searchWikiIndex()      ← LLM pre-pass against index.md
    │                              returns ["entities/foo.md", ...]
    ▼
store.readWikiPage() for each result
parseWikiFrontmatter()             ← extract sources: [{s3_key, file_path, hash}]
    │
    ├─ if source pointers:
    │   KnowledgeBaseClient.retrieveTargeted()  (KB filtered by s3_key)
    │
    └─ if no coverage:
        KnowledgeBaseClient.retrieveBroad()     (semantic search fallback)
    │
    ▼
budget context (60% wiki / 40% RAG, character-based)
staleness check (wiki hash vs. RAG chunk hash)
    │
    ▼
WikiClient.hybridQuery()           ← { system: SYSTEM_PROMPT, messages: [...] }
    │
    ▼
HybridQueryResult { answer, method, wikiPagesUsed, sourcesConsulted, warnings }
```

---

## Code Changes Required (9 files)

### 1. `package.json`
Add dependency: `"@aws-sdk/client-bedrock-agent-runtime": "^3.600.0"`
Add script: `"hybrid-query": "tsx index.ts hybrid-query"`

### 2. `config.ts`
Add config fields:
- `knowledgeBaseId?: string` (BEDROCK_KB_ID env var)
- `kbMaxResults: number` (KB_MAX_RESULTS, default 5)
- `hybridMaxChars: number` (HYBRID_MAX_CHARS, default 60000)

### 3. `store.ts`
Add types and function:
- `WikiSourcePointer` interface
- `ParsedWikiFrontmatter` interface
- `ParsedWikiPage` interface
- `parseWikiFrontmatter(relativePath, rawContent)` function

No changes to existing `Store` interface or `readWikiPage()` return type (backward compat).

### 4. `kb.ts` (new file)
New `KnowledgeBaseClient` class wrapping Bedrock Agent Runtime SDK:
- `retrieveTargeted(params)` — filtered KB retrieval using wiki pointers
- `retrieveBroad(params)` — semantic search fallback

### 5. `client.ts`
Three additions:
- Update `SCHEMA` and `INGEST_PROMPT` to emit structured `sources:` YAML frontmatter
- Add `searchWikiIndex(question, indexContent)` — LLM pre-pass returns relevant page paths
- Add `hybridQuery(params)` — dual-input inference with separate system prompt

New types exported:
- `ConversationMessage`
- `HybridQueryParams`
- `HybridQueryResult`

### 6. `engine.ts`
Add `hybridQuery(question, knowledgeBaseId, options?)` method orchestrating:
1. Index lookup → page selection
2. Wiki page reads and parse
3. KB retrieval (targeted or broad)
4. Staleness detection
5. Context budgeting
6. LLM inference
7. Optional synthesis persist

New type exported: `HybridQueryResult`

### 7. `lambda.ts`
Add `hybrid_query` action to direct event handler. New fields: `knowledgeBaseId`, `orgName`, `history`.

### 8. `index.ts`
Add `hybrid-query` CLI command with options: `--kb-id`, `--org`, `--no-persist`.

### 9. `wiki-rag-dual-input-query.md`
Rewrite to:
- Replace Python-only with TypeScript-primary framing
- Restructure main query function as six numbered steps
- Update `search_wiki_index` to LLM pre-pass approach
- Add structured frontmatter YAML schema section
- Add module map table
- Add multi-turn conversation section
- Add KB setup instructions

---

## Key Design Decisions

| Decision | Why |
|---|---|
| LLM pre-pass for wiki nav (not vector index) | `index.md` exists already; avoids 2nd index; costs ~$0.001/query |
| Bedrock KB (not raw OpenSearch) | AWS-managed, S3 data source sync, simpler ops |
| Char budget (not tiktoken) | No new dependency; 60k chars ≈ 15k tokens (conservative) |
| `parseWikiFrontmatter()` standalone | Pure string transform; avoids code dup in LocalStore + S3Store |
| Synthesis via 2nd query call | Keeps existing WikiDiff machinery; avoids forcing hybrid answer to JSON |
| `knowledgeBaseId` as param | One deployment can serve multiple compartments with different KBs |

---

## Implementation Sequence

1. `package.json` — add dependency
2. `config.ts` — add config fields
3. `store.ts` — add types + parser
4. `kb.ts` — new file
5. `client.ts` — SCHEMA update, searchWikiIndex, hybridQuery
6. `engine.ts` — add hybridQuery method
7. `lambda.ts` — add hybrid_query action
8. `index.ts` — add hybrid-query command
9. `wiki-rag-dual-input-query.md` — rewrite (done first; no-code-change)

---

## Verification Steps

```bash
# 1. Install new SDK
npm install

# 2. Test existing paths still work
npm run status

# 3. After full ingest, check wiki frontmatter has sources:
cat compartments/tolkien/wiki/entities/gandalf.md | head -30

# 4. Test hybrid query (requires BEDROCK_KB_ID set)
BEDROCK_KB_ID=<id> npx tsx index.ts -c tolkien hybrid-query "Who are the Istari?"

# 5. Test broad fallback (no wiki coverage)
BEDROCK_KB_ID=<id> npx tsx index.ts -c tolkien hybrid-query "What is the weather?"
# Expected: method = "rag_fallback", wikiPagesUsed = []

# 6. Test multi-turn via Lambda event
aws lambda invoke --function-name wiki-query --payload '{"action":"hybrid_query","question":"What is...","history":[...]}' output.json
```

---

## Notes for Future

- **Token counting**: Current implementation uses character approximation (1 token ≈ 4 chars). For exact counts, use `CountTokensCommand` from `@aws-sdk/client-bedrock-runtime`.
- **KB metadata**: Staleness detection depends on KB metadata mapping. Configure `x-amz-meta-sha256` capture at KB setup time.
- **Data source sync**: Requires manual trigger (CLI/console) or a Lambda that calls `StartIngestionJobCommand` after ingest completes.
- **Conversation state**: No persistence layer — history is passed per-call. For multi-turn sessions, caller maintains the array.
- **Broad fallback cost**: Requests with no wiki coverage trigger broad semantic search at higher token cost. Consider optimizing index query if this becomes common.

