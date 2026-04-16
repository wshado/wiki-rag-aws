# AWS Test Environment Checklist: Hybrid Wiki-RAG

## Minimal Setup (for rapid testing)

```
┌─────────────────────────────────────────────────────────────┐
│                     AWS Test Environment                      │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  S3 Bucket                                            │   │
│  │  └─ /compartments/test/raw/          (source docs)  │   │
│  │  └─ /compartments/test/wiki/         (compiled)     │   │
│  │  └─ /rag-embeddings/chunks/          (RAG vectors)  │   │
│  └──────────────────────────────────────────────────────┘   │
│                         ▲                                     │
│                         │                                     │
│         ┌───────────────┼───────────────┐                    │
│         │               │               │                    │
│    ┌────▼──┐      ┌─────▼──┐      ┌────▼────┐               │
│    │ Bedrock        │ Bedrock      │ Bedrock  │              │
│    │ Claude Opus    │ Embeddings   │ Sonnet   │              │
│    │ (ingest)       │ (RAG chunks) │ (query)  │              │
│    └────────┘      └────────┘      └────────┘               │
│                                                               │
│    Optional: DynamoDB for embedding metadata                │
│    (alternative to inline S3 metadata)                       │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

---

## AWS Services by Role

### Storage
- **S3 Bucket** (existing in your setup)
  - Raw documents: `s3://bucket/compartments/test/raw/`
  - Wiki pages: `s3://bucket/compartments/test/wiki/`
  - Embedding vectors: `s3://bucket/rag-embeddings/` (JSON files or Parquet)
  - Estimated cost: $0.00-0.50/month for test volume

### Embedding / RAG
Choose ONE of these approaches:

#### Option A: Bedrock Knowledge Bases (Most Complete, Managed)
- **Bedrock Knowledge Bases** (AWS-managed OpenSearch Serverless)
  - Handles chunking, embedding, storage, retrieval automatically
  - You upload raw docs to S3, KB syncs and indexes them
  - Query via `RetrieveCommand` from `@aws-sdk/client-bedrock-agent-runtime`
  - Cost: $0.10/hour when active + $0.10/1M vectors + retrieval charges
  - Best for: full end-to-end testing without managing OpenSearch

#### Option B: Bedrock Embeddings + DynamoDB (Lightweight, DIY)
- **Bedrock Embeddings Model** (Titan Embeddings v2 or Cohere Embed)
  - Call via `@aws-sdk/client-bedrock-runtime`
  - You chunk documents yourself (use existing `chunkSource()`)
  - Embed chunks via Bedrock embedding model
  - Cost: $0.02 per 100K input tokens (~1 cent per 5M tokens)
  
- **DynamoDB** (or S3 JSON files)
  - Store: `{ chunk_id, s3_key, embedding: [float array], content, metadata }`
  - Query: use DynamoDB's search client + similarity search in Python/Node
  - Cost: $1.25/month for on-demand (minimal test)
  
- **Lambda** (optional, for similarity search)
  - Retrieves embeddings from DynamoDB, computes cosine similarity
  - Cost: ~$0.0000002 per invocation

#### Option C: OpenSearch Serverless (Mid-Weight, Full-Featured)
- **Amazon OpenSearch Serverless**
  - Full vector search + metadata filtering
  - Can use Bedrock embeddings or custom embeddings
  - Cost: $0.30-0.50/month for small test workloads (on-demand, no provisioning)
  - More complex than KB but more control

### LLM Models

#### Claude for Wiki Ingest (Existing)
- **Bedrock Claude Opus 4.6** (or direct Anthropic API)
  - Role: compile raw documents into structured wiki
  - Cost: ~$15/Mtokens input, ~$60/Mtokens output (Bedrock pricing)
  - You have this working already

#### Claude for Hybrid Query (New)
- **Bedrock Claude Sonnet 4.6** (or direct Anthropic API)
  - Role: synthesize answer from wiki + RAG chunks
  - Cost: ~$3/Mtokens input, ~$15/Mtokens output
  - Lower cost than Opus, fast enough for query path

---

## Recommended: Option A (Bedrock Knowledge Bases)

**Why this for testing**:
- Single AWS service handles all RAG complexity (chunking, embedding, storage, retrieval)
- Direct integration with `@aws-sdk/client-bedrock-agent-runtime` (already used in your codebase)
- No additional infrastructure to manage
- Easy to tear down and rebuild for testing

**Setup Steps**:
```bash
# 1. Create KB
aws bedrock-agent create-knowledge-base \
  --name "wiki-test-rag" \
  --role-arn "arn:aws:iam::ACCOUNT:role/BedrockKBTestRole" \
  --knowledge-base-configuration type=VECTOR \
  --storage-configuration type=OPENSEARCH_SERVERLESS

# 2. Create data source pointing to your S3 raw folder
aws bedrock-agent create-data-source \
  --knowledge-base-id <KB_ID> \
  --name "test-raw-docs" \
  --data-source-configuration \
    type=S3,\
    s3BucketArn="arn:aws:s3:::your-test-bucket",\
    inclusionPatterns=["compartments/test/raw/*"]

# 3. Start ingestion
aws bedrock-agent start-ingestion-job \
  --knowledge-base-id <KB_ID> \
  --data-source-id <DATA_SOURCE_ID>

# 4. Test retrieval
BEDROCK_KB_ID=<KB_ID> npx tsx hybrid-rag-test.ts
```

**Cost for test**: ~$2-5 for a few test runs (index 1 doc, run 5-10 queries)

---

## Recommended: Option B (Bedrock Embeddings + DynamoDB)

**Why this for testing**:
- Lower cost than KB ($0 for storage, ~$0.01 per embedding batch)
- Full control over chunking and indexing logic
- Good for understanding how embeddings work
- Can prototype similarity search logic locally

**Setup Steps**:
```bash
# 1. Create DynamoDB table
aws dynamodb create-table \
  --table-name rag-chunks-test \
  --attribute-definitions AttributeName=chunk_id,AttributeType=S \
  --key-schema AttributeName=chunk_id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST

# 2. Use existing chunkSource() to chunk your test docs

# 3. Call Bedrock Embeddings
bedrock.invoke_model({
  modelId: "amazon.titan-embed-text-v2:0",
  body: JSON.stringify({ inputText: chunk_text })
})

# 4. Store in DynamoDB and search via similarity
# (Write a ~20-line similarity search function)
```

**Cost for test**: ~$0.50 for 50 documents, 100 queries

---

## Test Data Set

For private testing, use a small, self-contained document set:

### Option 1: Use existing Tolkien test docs (your current setup)
- Already have The Hobbit, LotR, Silmarillion
- Full end-to-end test without needing new data
- Cost: might exceed free tier; watch the meter

### Option 2: Create minimal test docs (recommended for fast iteration)
```
compartments/test/raw/
├── policy-retention.txt       (100KB - simple text)
├── security-handbook.md       (200KB - markdown)
└── org-structure.pdf          (50KB - small PDF)
```

These are small enough that:
- S3 operations are free (< 1GB)
- Bedrock embedding = ~$0.001 total
- KB ingestion = ~$0.10
- Query test runs = ~$0.10 each
- Total: ~$1-2 for 10 test cycles

---

## IAM Role for Testing

Create a minimal test role that includes only what you need:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:Retrieve",
        "bedrock:RetrieveAndGenerate"
      ],
      "Resource": [
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-6-*",
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6-*",
        "arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0",
        "arn:aws:bedrock:us-east-1:ACCOUNT:knowledge-base/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::your-test-bucket/compartments/test/*",
        "arn:aws:s3:::your-test-bucket/rag-embeddings/*",
        "arn:aws:s3:::your-test-bucket"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:Scan"
      ],
      "Resource": "arn:aws:dynamodb:us-east-1:ACCOUNT:table/rag-chunks-test"
    },
    {
      "Effect": "Allow",
      "Action": [
        "bedrock-agent:CreateKnowledgeBase",
        "bedrock-agent:DeleteKnowledgeBase",
        "bedrock-agent:CreateDataSource",
        "bedrock-agent:StartIngestionJob"
      ],
      "Resource": "arn:aws:bedrock:us-east-1:ACCOUNT:knowledge-base/*"
    }
  ]
}
```

---

## Test Workflow

```
1. Prepare test data
   └─ Create compartments/test/raw/ with 2-3 small documents

2. Run ingest pipeline (existing)
   └─ npx tsx index.ts -c test ingest --all
   └─ Generates: compartments/test/wiki/

3. Initialize RAG backend
   Option A: Create Bedrock KB (manual or CloudFormation)
   Option B: Create DynamoDB table + call embedding API

4. Index raw docs into RAG
   Option A: KB data source sync
   Option B: Write chunk → embedding → DynamoDB script

5. Test hybrid query
   └─ BEDROCK_KB_ID=<id> npx tsx index.ts -c test hybrid-query "sample question"
   └─ Should return both wiki synthesis + RAG chunks

6. Validate output
   └─ Check answer is coherent
   └─ Check sources cited correctly
   └─ Check staleness warnings (if applicable)

7. Cleanup
   └─ Delete KB, empty DynamoDB table, clear S3
   └─ Total cost should be $1-5
```

---

## Cost Comparison (Single Test Run: 1 Document, 10 Queries)

| Approach | Setup | Per-doc | Per-query | Total |
|---|---|---|---|---|
| **Option A: KB** | $0 | $0.10 | $0.10 | $1.10 |
| **Option B: Embeddings + DynamoDB** | $0 | $0.01 | $0.01 | $0.21 |
| **Option C: OpenSearch Serverless** | $0 | $0.20 | $0.05 | $0.70 |

**Recommendation for testing**: Start with **Option B** (cheapest), move to **Option A** (KB) once approach is validated.

---

## AWS CLI Commands for Quick Testing

```bash
# List available embedding models
aws bedrock list-foundation-models --region us-east-1 \
  --filter modelCapabilities=EMBEDDING

# List available Bedrock models for inference
aws bedrock list-foundation-models --region us-east-1 \
  --filter modelCapabilities=TEXT_GENERATION

# Invoke embedding model directly
aws bedrock-runtime invoke-model \
  --model-id "amazon.titan-embed-text-v2:0" \
  --body '{"inputText":"sample text"}' \
  output.json

# List your Knowledge Bases
aws bedrock-agent list-knowledge-bases --region us-east-1

# Check KB ingestion status
aws bedrock-agent get-ingestion-job \
  --knowledge-base-id <ID> \
  --data-source-id <ID> \
  --ingestion-job-id <ID>
```

---

## Next Steps

1. **Decide on approach**: KB (simpler) vs. Embeddings+DynamoDB (cheaper)
2. **Set region**: Use `us-east-1` (widest model availability)
3. **Create test compartment**: `compartments/test/` with 2-3 small docs
4. **Deploy test infrastructure**: KB or DynamoDB via CloudFormation or CLI
5. **Run ingest pipeline**: Already working for wiki generation
6. **Test hybrid query**: Once RAG backend is ready
7. **Monitor costs**: CloudWatch billing alarms for safety
