# Testbed → Cloud: S3 Wiki Store + Deployment Guide

## What changes and what doesn't

### No changes needed
- **engine.ts** — orchestration logic stays identical
- **kb.ts** — already uses @aws-sdk/client-bedrock-agent-runtime
- **client.ts** — swap one constructor (Anthropic → BedrockRuntime), prompt structure unchanged
- **parseWikiFrontmatter()** — pure string parsing, no I/O dependency
- **HYBRID_SYSTEM_PROMPT** — unchanged
- **budgetContext()** — unchanged
- **detectStaleness()** — unchanged

### Changes needed
- **store.ts** — filesystem I/O → S3 I/O (main change)
- **client.ts** — Anthropic API constructor → Bedrock InvokeModel
- **lambda.ts** — update environment config for S3 bucket/prefix
- **New: VPC endpoints** for bedrock-runtime + bedrock-agent-runtime + s3

---

## store.ts — S3-backed wiki store

Replace filesystem reads/writes with S3 operations. The interface
stays the same so engine.ts doesn't change.

```typescript
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

export interface WikiStoreConfig {
  bucket: string;      // e.g. "your-wiki-bucket"
  prefix: string;      // e.g. "compartments/corp-docs/wiki/"
}

export class S3WikiStore {
  constructor(private config: WikiStoreConfig) {}

  // ── Read operations (used by engine.ts during query) ──

  async readIndex(): Promise<string> {
    return this.readFile("index.md");
  }

  async readLog(): Promise<string> {
    return this.readFile("log.md");
  }

  async readSchema(): Promise<string> {
    return this.readFile("SCHEMA.md");
  }

  async readWikiPage(relativePath: string): Promise<string> {
    return this.readFile(relativePath);
  }

  // ── Write operations (used by engine.ts during ingest) ──

  async writeWikiPage(relativePath: string, content: string): Promise<void> {
    await this.writeFile(relativePath, content);
  }

  async appendToLog(entry: string): Promise<void> {
    const existing = await this.readLog();
    await this.writeFile("log.md", existing + "\n" + entry);
  }

  async writeIndex(content: string): Promise<void> {
    await this.writeFile("index.md", content);
  }

  // ── List operations (used for lint/health checks) ──

  async listPages(subdirectory?: string): Promise<string[]> {
    const prefix = subdirectory
      ? `${this.config.prefix}${subdirectory}/`
      : this.config.prefix;

    const pages: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await s3.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );

      for (const obj of response.Contents || []) {
        if (obj.Key && obj.Key.endsWith(".md")) {
          // Return path relative to wiki prefix
          const relative = obj.Key.replace(this.config.prefix, "");
          pages.push(relative);
        }
      }
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return pages;
  }

  // ── Private S3 helpers ──

  private async readFile(relativePath: string): Promise<string> {
    try {
      const response = await s3.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: `${this.config.prefix}${relativePath}`,
        })
      );
      return (await response.Body?.transformToString("utf-8")) || "";
    } catch (err: any) {
      if (err.name === "NoSuchKey") return "";
      throw err;
    }
  }

  private async writeFile(
    relativePath: string,
    content: string
  ): Promise<void> {
    await s3.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: `${this.config.prefix}${relativePath}`,
        Body: content,
        ContentType: "text/markdown; charset=utf-8",
      })
    );
  }
}
```

### Usage in engine.ts — zero changes to orchestration

```typescript
// Before (testbed):
// const store = new LocalWikiStore("./tolkien/wiki");

// After (cloud):
const store = new S3WikiStore({
  bucket: process.env.WIKI_BUCKET!,
  prefix: process.env.WIKI_PREFIX || "compartments/corp-docs/wiki/",
});

// Everything else in engine.ts stays identical:
const index = await store.readIndex();
const relevantPaths = await client.searchWikiIndex(question, index);
for (const relPath of relevantPaths) {
  const raw = await store.readWikiPage(relPath);
  const parsed = parseWikiFrontmatter(relPath, raw);
  // ... same as before
}
```

---

## client.ts — Anthropic API → Bedrock InvokeModel

The prompt structure and system prompt are identical. Only the
transport layer changes.

```typescript
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-east-1",
  // VPC endpoint URL if running in private subnet:
  // endpoint: process.env.BEDROCK_ENDPOINT_URL
});

export class BedrockWikiClient {
  private modelId: string;

  constructor(modelId = "anthropic.claude-sonnet-4-20250514-v1:0") {
    this.modelId = modelId;
  }

  async call(
    prompt: string,
    model?: string,
    maxTokens = 4096
  ): Promise<string> {
    const response = await bedrock.send(
      new InvokeModelCommand({
        modelId: model || this.modelId,
        contentType: "application/json",
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      })
    );

    const result = JSON.parse(
      new TextDecoder().decode(response.body)
    );
    return result.content[0].text;
  }

  async hybridQuery(params: {
    question: string;
    wikiContext: string;
    ragContext: string;
    method: string;
    orgName: string;
    history?: ConversationMessage[];
  }): Promise<string> {
    const userMessage = `Answer this question using the wiki synthesis and source excerpts below.

QUESTION: ${params.question}

${"=".repeat(60)}
WIKI SYNTHESIS (compiled knowledge — use for overview, cross-references, contradiction flags):
${"=".repeat(60)}
${params.wikiContext || "(No wiki coverage for this topic)"}

${"=".repeat(60)}
SOURCE EXCERPTS (original document text — use for exact wording and verification):
${"=".repeat(60)}
${params.ragContext || "(No source excerpts retrieved)"}`;

    const messages: any[] = [];
    if (params.history) {
      messages.push(...params.history);
    }
    messages.push({ role: "user", content: userMessage });

    const response = await bedrock.send(
      new InvokeModelCommand({
        modelId: this.modelId,
        contentType: "application/json",
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 4096,
          system: HYBRID_SYSTEM_PROMPT.replace("{org_name}", params.orgName),
          messages,
        }),
      })
    );

    const result = JSON.parse(
      new TextDecoder().decode(response.body)
    );
    return result.content[0].text;
  }
}
```

---

## lambda.ts — cloud entry point

Your existing lambda.ts handles the `hybrid_query` action.
Update it to use the S3 store and Bedrock client:

```typescript
import { S3WikiStore } from "./store";
import { BedrockWikiClient } from "./client";
import { KnowledgeBaseClient } from "./kb";
import { WikiEngine } from "./engine";

const store = new S3WikiStore({
  bucket: process.env.WIKI_BUCKET!,
  prefix: process.env.WIKI_PREFIX!,
});

const client = new BedrockWikiClient(
  process.env.MODEL_ID || "anthropic.claude-sonnet-4-20250514-v1:0"
);

const kb = new KnowledgeBaseClient(
  process.env.BEDROCK_KB_ID!
);

const engine = new WikiEngine(store, client, kb);

export async function handler(event: any) {
  const { action, question, knowledgeBaseId, history } = event;

  switch (action) {
    case "hybrid_query":
      return engine.hybridQuery(
        question,
        knowledgeBaseId || process.env.BEDROCK_KB_ID!,
        { history }
      );

    case "ingest":
      const { s3Key, sourceMetadata } = event;
      return engine.ingestDocument(s3Key, sourceMetadata);

    case "lint":
      return engine.lintWiki();

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
```

---

## EventBridge rule: auto-ingest on AD sync

When a document syncs from the AD drive to S3, trigger
the ingest Lambda automatically:

```json
{
  "source": ["aws.s3"],
  "detail-type": ["Object Created"],
  "detail": {
    "bucket": { "name": ["your-wiki-bucket"] },
    "object": {
      "key": [{ "prefix": "compartments/corp-docs/raw/" }]
    }
  }
}
```

Target: Lambda function running your `handler` with action "ingest".

The Lambda reads the new raw doc from S3, runs your existing ingest
logic (which calls Bedrock to compile wiki pages), writes updated
wiki pages back to S3, then triggers a KB sync.

```typescript
// EventBridge → Lambda adapter (add to lambda.ts)
export async function eventBridgeHandler(event: any) {
  const s3Key = event.detail.object.key;
  const bucket = event.detail.bucket.name;

  // Read source file metadata
  const s3Client = new S3Client({});
  const head = await s3Client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: s3Key })
  );

  const sourceMetadata = {
    s3_key: s3Key,
    file_path: s3Key.split("/").pop(),
    hash: head.Metadata?.sha256 || "",
    sync_date: new Date().toISOString(),
    file_type: s3Key.split(".").pop(),
  };

  // Run ingest
  const result = await engine.ingestDocument(s3Key, sourceMetadata);

  // Trigger KB sync after wiki update
  const bedrockAgent = new BedrockAgentClient({});
  await bedrockAgent.send(
    new StartIngestionJobCommand({
      knowledgeBaseId: process.env.BEDROCK_KB_ID!,
      dataSourceId: process.env.BEDROCK_DS_ID!,
    })
  );

  return result;
}
```

---

## VPC endpoints needed (add to existing VPC)

Your existing setup already has:
- com.amazonaws.{region}.bedrock-runtime (for inference)

Add these for the cloud wiki system:
- com.amazonaws.{region}.bedrock-agent-runtime (for KB Retrieve)
- com.amazonaws.{region}.s3 (gateway endpoint — for wiki S3 reads/writes)

If running in Lambda inside VPC (recommended for private subnet access):
- com.amazonaws.{region}.lambda (for async invocation)

---

## Environment variables (Lambda / ECS)

```bash
WIKI_BUCKET=your-wiki-bucket
WIKI_PREFIX=compartments/corp-docs/wiki/
BEDROCK_KB_ID=ABCDEF1234
BEDROCK_DS_ID=GHIJKL5678
MODEL_ID=anthropic.claude-sonnet-4-20250514-v1:0
AWS_REGION=us-east-1
```

---

## Migration checklist

1. [ ] Create S3 bucket (or prefix) for wiki storage
2. [ ] Upload seed files: SCHEMA.md, index.md, log.md
3. [ ] Deploy S3WikiStore (replace LocalWikiStore in engine.ts)
4. [ ] Deploy BedrockWikiClient (replace Anthropic API client)
5. [ ] Add VPC endpoints: bedrock-agent-runtime, s3
6. [ ] Deploy Lambda with handler + eventBridgeHandler
7. [ ] Create EventBridge rule on raw/ prefix
8. [ ] Test: manually ingest one doc from testbed corpus
9. [ ] Verify: wiki pages appear in S3, KB sync runs
10. [ ] Test: hybrid-query against cloud wiki + KB
11. [ ] Compare: cloud answers vs testbed answers (same questions)
12. [ ] Connect: AD drive sync to raw/ prefix
13. [ ] Monitor: CloudWatch logs for ingest + query latency

---

## What your Tolkien testbed proved

Your testbed validated the core pattern:
- Wiki index navigation (LLM pre-pass against index.md) works
- Source pointer extraction from frontmatter enables targeted KB retrieval
- Hybrid context (wiki + RAG) produces better answers than either alone
- Staleness detection via hash comparison catches drift
- Multi-turn conversation maintains context

The cloud deployment doesn't change any of this logic. It changes
WHERE the wiki lives (S3 not disk), HOW Claude is called (Bedrock
not API), and WHAT triggers ingest (EventBridge not CLI). The
intelligence — the hybrid query flow, the dual-input prompt, the
source pointers, the budget management — is all in your TypeScript
modules and carries over unchanged.
