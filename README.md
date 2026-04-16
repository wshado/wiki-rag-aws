# LLM-Wiki Generator — Compartmentalised, Bedrock + S3
**Flipping back to Bedrock**

client.ts: comment the Anthropic import + new Anthropic() constructor; uncomment the AnthropicBedrock import + constructor.
config.ts: comment the claude-* model defaults; uncomment the us.anthropic.* Bedrock defaults.
Set STORE_BACKEND=s3 + S3_BUCKET=... env vars (for AWS deployment).
No other file touches required.

TypeScript implementation of [Karpathy's LLM-Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f),
designed to compile internal team documentation into structured,
interlinked markdown wikis.

- **Model**: Amazon Bedrock (Claude Opus 4.6 for ingest/lint, Sonnet 4.6 for query)
- **Storage**: S3 (one prefix per team) or local filesystem (for dev)
- **Compute**: ECS Fargate for bulk/initial ingest, Lambda for incremental updates
- **Compartmentalised**: each team is an isolated S3 prefix + CLAUDE.md schema

## Three Layers (per the gist)

- [raw/](compartments/) — immutable source documents, one per team
- **wiki/** — LLM-maintained markdown (entities, concepts, syntheses, index, log)
- **CLAUDE.md** — per-team schema the model reads to know how to behave

## Architecture

```
            ┌───────────────────────────────────────────────┐
            │                 S3 Bucket                      │
            │   wikis/{team-a}/raw/…                         │
            │   wikis/{team-a}/wiki/…                        │
            │   wikis/{team-b}/raw/…                         │
            │   wikis/{team-b}/wiki/…                        │
            └──────────┬────────────────────┬────────────────┘
                       │                    │
               Fargate task            Lambda function
           (bulk / first-time         (incremental doc
            ingest, no timeout)         updates, < 15 min)
                       │                    │
                       └────────┬───────────┘
                                │
                         Bedrock Runtime
                         (Claude Opus 4.6)
```

- **Fargate** handles first-time builds of a team's wiki (the LotR trilogy
  takes ~30 chunks; no Lambda will finish that). Entry point is the
  [Dockerfile](Dockerfile) which runs `node dist/index.js ingest --all` by
  default.
- **Lambda** handles single-document updates once a wiki exists. Entry
  point is [lambda.ts](lambda.ts) `handler`, invoked directly or via an S3
  event trigger (placeholder — not wired).

## Compartmentalisation

Each team (compartment) is an isolated key prefix under a shared bucket:

```
s3://<bucket>/wikis/team-security/raw/*
s3://<bucket>/wikis/team-security/wiki/*
s3://<bucket>/wikis/team-security/wiki/CLAUDE.md
s3://<bucket>/wikis/team-platform/raw/*
s3://<bucket>/wikis/team-platform/wiki/*
s3://<bucket>/wikis/team-platform/wiki/CLAUDE.md
```

- Teams can be isolated at the IAM-policy level by granting each principal
  `s3:*Object` only on their own prefix.
- Each team gets its own `CLAUDE.md` auto-generated on first run; teams
  can edit it to add domain-specific entity/concept types.
- One Bedrock IAM role is sufficient (same model for all teams). If you
  need per-team audit trails on Bedrock calls, assume a per-team role
  before each engine construction — the `WikiClient` honours the ambient
  AWS credential chain.

## Configuration

Everything is driven by environment variables. See [config.ts](config.ts).

| Var | Default | Meaning |
|---|---|---|
| `STORE_BACKEND` | `local` | `local` (dev) or `s3` (AWS) |
| `COMPARTMENT` | `tolkien` | Default team id; override with `--compartment` on CLI |
| `LOCAL_ROOT` | `./compartments` | Local store root directory |
| `S3_BUCKET` | _unset_ | Required for `s3` backend |
| `S3_KEY_PREFIX` | _empty_ | e.g. `wikis/` |
| `AWS_REGION` | `us-east-1` | |
| `BEDROCK_WIKI_MODEL` | `us.anthropic.claude-opus-4-6-20251101-v1:0` | Inference profile for ingest/lint |
| `BEDROCK_QUERY_MODEL` | `us.anthropic.claude-sonnet-4-6-20251101-v1:0` | Inference profile for query |
| `CHUNK_CHARS` | `80000` | Chunk size for long documents |
| `CHUNK_OVERLAP` | `2000` | Overlap between chunks |
| `MAX_WIKI_PAGES` | `150` | Max pages pulled into context for query/lint |

## Required IAM permissions

The Fargate task role and Lambda execution role need:

**Bedrock:**
```json
{
  "Effect": "Allow",
  "Action": ["bedrock:InvokeModel"],
  "Resource": [
    "arn:aws:bedrock:us-*::foundation-model/anthropic.claude-opus-4-6-*",
    "arn:aws:bedrock:us-*::foundation-model/anthropic.claude-sonnet-4-6-*",
    "arn:aws:bedrock:us-*:ACCOUNT:inference-profile/us.anthropic.claude-opus-4-6-*",
    "arn:aws:bedrock:us-*:ACCOUNT:inference-profile/us.anthropic.claude-sonnet-4-6-*"
  ]
}
```

Cross-region inference profiles (`us.anthropic.*`) require `InvokeModel`
on both the profile ARN **and** the underlying foundation-model ARNs in
every region the profile can dispatch to.

**S3:**
```json
{
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
  "Resource": [
    "arn:aws:s3:::YOUR_BUCKET",
    "arn:aws:s3:::YOUR_BUCKET/wikis/*"
  ]
}
```

## Local dev (Tolkien scratch testing)

The repo's [raw/](raw/) folder ships with three Tolkien PDFs. They're
copied into `compartments/tolkien/raw/` on first clone — that's the
scratch compartment for development.

### Prereqs

- Node 22+
- AWS credentials with Bedrock access (`aws configure sso` or env vars)

### Install and run

```bash
npm install

# Smoke test — shows the local compartment layout
npm run status

# Status for a specific compartment
npx tsx index.ts -c tolkien status

# Bulk ingest all three Tolkien PDFs (chunked; will take a while)
npx tsx index.ts -c tolkien ingest --all

# Ask a question against the compiled wiki
npx tsx index.ts -c tolkien query "Who are the Istari?"

# Periodic health check
npx tsx index.ts -c tolkien lint
```

Set `STORE_BACKEND=s3` + `S3_BUCKET=...` to run against S3 locally (useful
for debugging permissions before deploying).

## Deploying

### Fargate (bulk ingest)

```bash
# Build and push
docker build -t wiki-ingest .
docker tag wiki-ingest:latest $ECR_URI:latest
docker push $ECR_URI:latest
```

Task definition env:
```
STORE_BACKEND=s3
S3_BUCKET=your-bucket
S3_KEY_PREFIX=wikis/
COMPARTMENT=team-security
AWS_REGION=us-east-1
```

Trigger the task with a specific `COMPARTMENT` override per team. The
default command (`ingest --all`) walks every pending source file under
that team's prefix and ingests each one sequentially.

### Lambda (incremental updates)

```bash
npm run build
cd dist && zip -r ../lambda.zip . && cd ..
# zip up node_modules too — or use a Lambda layer
```

Lambda config:
- Runtime: Node.js 22
- Handler: `lambda.handler`
- Memory: 1024 MB (PDF parsing can spike)
- Timeout: 15 min (for safety on chunked docs)
- Env: same as Fargate task
- Execution role: Bedrock + S3 permissions above

Invoke shapes — see [lambda.ts](lambda.ts) for full schema:

```json
{"action": "ingest", "compartment": "team-security", "filePath": "wikis/team-security/raw/runbook.pdf"}
{"action": "query",  "compartment": "team-security", "question": "who owns auth?"}
{"action": "lint",   "compartment": "team-security"}
```

Trigger wiring (S3 PutObject notification → Lambda) is a placeholder for
now — the handler already supports S3 event shape so dropping a doc in
`s3://bucket/wikis/team-x/raw/` can invoke an ingest automatically once
the notification is wired.

## Known limitations

- **Log / registry concurrency**: S3 has no atomic append. Simultaneous
  Lambda invocations for the same compartment can race on `log.md` and
  `meta/ingested.json` (read-modify-write, last writer wins). Fine at
  human-driven cadence; if concurrent ingests become common, move these
  two files to DynamoDB. Search for `CONCURRENCY:` in [store.ts](store.ts).
- **Query context assembly** reads every `.md` under a compartment's
  `wiki/` prefix in parallel batches of 20. For wikis with hundreds of
  pages this becomes the dominant latency cost. Introduce a cache layer
  or materialised index when needed.
- **Lambda + 15-min timeout**: big first-time ingests must go through
  Fargate. Incremental single-doc updates fit Lambda comfortably.

## Project layout

```
WikiRAGObsidian/
  config.ts         env-driven config
  store.ts          Store interface + LocalStore + S3Store
  client.ts         Bedrock client + ingest/query/lint prompts
  engine.ts         Orchestration (chunked ingest, apply diffs, default schema)
  index.ts          CLI entry point (local dev + Fargate container)
  lambda.ts         Lambda handler (incremental updates)
  Dockerfile        Fargate image build
  raw/              Tolkien scratch PDFs (dev only)
  compartments/     Local store root (dev only, git-ignored)
    tolkien/
      raw/          Scratch input
      wiki/         LLM-built wiki output
```
