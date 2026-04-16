# AWS Deployment Plan: ECR + Bedrock + S3

Complete end-to-end guide for deploying the wiki-rag system to AWS with Bedrock Claude and Lambda/Fargate.

---

## Context

The codebase is already structured for AWS deployment:
- `Dockerfile` builds a Fargate-ready container for bulk ingest
- `lambda.ts` is the incremental S3-triggered ingest handler
- `@anthropic-ai/bedrock-sdk` is already in `package.json` — no install needed
- Bedrock constructor + model IDs are commented out in `client.ts` (lines 19–20, 197–207) and `config.ts` (lines 90–91) — 6 line changes to flip

Goal: swap SDK to Bedrock, add `.dockerignore`, push image to ECR, deploy Lambda as zip, wire S3 trigger → Lambda, register ECS task definition for bulk ingest.

---

## Architecture

```
S3 Bucket
├── compartments/{team}/raw/       ← raw PDFs/txts (already in S3)
│         │
│         └─ PUT event ───────────► Lambda (incremental, ≤15 min docs)
│                                       Bedrock Claude Sonnet
│                                       writes wiki pages → S3
└── compartments/{team}/wiki/      ← compiled wiki (output)

ECR Repository
└── wiki-rag:latest ──────────────► ECS Fargate (bulk ingest, all docs)
                                        Bedrock Claude Opus
                                        reads raw/ writes wiki/ on S3
```

---

## Step 1 — Flip 6 Lines: Anthropic SDK → Bedrock SDK

### client.ts

Lines 19–20 (swap import):
```typescript
// Comment out:
import Anthropic from "@anthropic-ai/sdk";
// Uncomment:
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
```

Lines 188–207 (swap constructor):
```typescript
// Comment out (lines 188–194):
private client: Anthropic;
constructor() { this.client = new Anthropic(); }

// Uncomment (lines 197–207):
private client: AnthropicBedrock;
constructor() {
  this.client = new AnthropicBedrock({ awsRegion: config.region });
}
```

### config.ts

Lines 82–83 / 90–91 (swap model IDs):
```typescript
// Comment out lines 82–83:
wikiModel: env("WIKI_MODEL", "claude-sonnet-4-6")!,
queryModel: env("QUERY_MODEL", "claude-sonnet-4-6")!,

// Uncomment lines 90–91:
wikiModel: env("BEDROCK_WIKI_MODEL", "us.anthropic.claude-opus-4-6-20251101-v1:0")!,
queryModel: env("QUERY_MODEL", "us.anthropic.claude-sonnet-4-6-20251101-v1:0")!,
```

---

## Step 2 — Create `.dockerignore`

New file at project root:
```
node_modules/
dist/
compartments/
.env
*.local
*.log
.git/
supporting_documents/
```

---

## Step 3 — Build and Push to ECR

```bash
# Create repo
aws ecr create-repository --repository-name wiki-rag --region MY-REGION

# Authenticate Docker to ECR
aws ecr get-login-password --region MY-REGION \
  | docker login --username AWS --password-stdin \
    MY-ACCOUNT.dkr.ecr.MY-REGION.amazonaws.com

# Build, tag, push
docker build -t wiki-rag .
docker tag wiki-rag:latest MY-ACCOUNT.dkr.ecr.MY-REGION.amazonaws.com/wiki-rag:latest
docker push MY-ACCOUNT.dkr.ecr.MY-REGION.amazonaws.com/wiki-rag:latest
```

---

## Step 4 — IAM Execution Role

Create `wiki-rag-execution-role` (used by both Lambda and ECS task role):
```json
{
  "Statement": [
    {
      "Sid": "S3ReadWrite",
      "Effect": "Allow",
      "Action": ["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::MY-BUCKET",
        "arn:aws:s3:::MY-BUCKET/compartments/*"
      ]
    },
    {
      "Sid": "BedrockInvoke",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream"],
      "Resource": [
        "arn:aws:bedrock:MY-REGION::foundation-model/anthropic.claude-opus-4-6*",
        "arn:aws:bedrock:MY-REGION::foundation-model/anthropic.claude-sonnet-4-6*",
        "arn:aws:bedrock:MY-REGION:MY-ACCOUNT:inference-profile/us.anthropic.claude-opus-4-6*",
        "arn:aws:bedrock:MY-REGION:MY-ACCOUNT:inference-profile/us.anthropic.claude-sonnet-4-6*"
      ]
    },
    {
      "Sid": "Logs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],
      "Resource": "arn:aws:logs:*:*:*"
    }
  ]
}
```
Trust policy: `lambda.amazonaws.com` + `ecs-tasks.amazonaws.com`.

---

## Step 5 — Deploy Lambda as Zip

```bash
npx tsc
zip -r wiki-rag-lambda.zip dist/ node_modules/ package.json

aws lambda create-function \
  --function-name wiki-rag-ingest \
  --runtime nodejs22.x \
  --role arn:aws:iam::MY-ACCOUNT:role/wiki-rag-execution-role \
  --handler dist/lambda.handler \
  --zip-file fileb://wiki-rag-lambda.zip \
  --timeout 900 \
  --memory-size 1024 \
  --environment 'Variables={
    STORE_BACKEND=s3,
    S3_BUCKET=MY-BUCKET,
    S3_KEY_PREFIX=compartments/,
    AWS_REGION=MY-REGION,
    BEDROCK_WIKI_MODEL=us.anthropic.claude-opus-4-6-20251101-v1:0
  }' \
  --region MY-REGION

# Subsequent redeploys:
aws lambda update-function-code \
  --function-name wiki-rag-ingest \
  --zip-file fileb://wiki-rag-lambda.zip
```

---

## Step 6 — Wire S3 Trigger → Lambda

```bash
# Allow S3 to invoke Lambda
aws lambda add-permission \
  --function-name wiki-rag-ingest \
  --principal s3.amazonaws.com \
  --statement-id s3-trigger \
  --action lambda:InvokeFunction \
  --source-arn arn:aws:s3:::MY-BUCKET \
  --source-account MY-ACCOUNT

# Add S3 PUT notification (fires on .pdf and .txt under compartments/)
aws s3api put-bucket-notification-configuration \
  --bucket MY-BUCKET \
  --notification-configuration file://s3-trigger.json
```

`s3-trigger.json` (two rules — one per suffix, since S3 does not support OR in a single filter):
```json
{
  "LambdaFunctionConfigurations": [
    {
      "LambdaFunctionArn": "arn:aws:lambda:MY-REGION:MY-ACCOUNT:function:wiki-rag-ingest",
      "Events": ["s3:ObjectCreated:*"],
      "Filter": { "Key": { "FilterRules": [
        { "Name": "prefix", "Value": "compartments/" },
        { "Name": "suffix", "Value": ".pdf" }
      ]}}
    },
    {
      "LambdaFunctionArn": "arn:aws:lambda:MY-REGION:MY-ACCOUNT:function:wiki-rag-ingest",
      "Events": ["s3:ObjectCreated:*"],
      "Filter": { "Key": { "FilterRules": [
        { "Name": "prefix", "Value": "compartments/" },
        { "Name": "suffix", "Value": ".txt" }
      ]}}
    }
  ]
}
```

---

## Step 7 — ECS Fargate Task Definition (Bulk Ingest)

```bash
aws ecs register-task-definition --cli-input-json file://task-def.json
```

`task-def.json`:
```json
{
  "family": "wiki-rag-bulk-ingest",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024", "memory": "2048",
  "executionRoleArn": "arn:aws:iam::MY-ACCOUNT:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::MY-ACCOUNT:role/wiki-rag-execution-role",
  "containerDefinitions": [{
    "name": "wiki-rag",
    "image": "MY-ACCOUNT.dkr.ecr.MY-REGION.amazonaws.com/wiki-rag:latest",
    "essential": true,
    "command": ["ingest", "--all"],
    "environment": [
      { "name": "STORE_BACKEND", "value": "s3" },
      { "name": "S3_BUCKET", "value": "MY-BUCKET" },
      { "name": "S3_KEY_PREFIX", "value": "compartments/" },
      { "name": "COMPARTMENT", "value": "TEAM" },
      { "name": "AWS_REGION", "value": "MY-REGION" },
      { "name": "BEDROCK_WIKI_MODEL", "value": "us.anthropic.claude-opus-4-6-20251101-v1:0" }
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/wiki-rag",
        "awslogs-region": "MY-REGION",
        "awslogs-stream-prefix": "ecs"
      }
    }
  }]
}
```

---

## Step 8 — Verify

```bash
# Direct Lambda test: ingest one file already in S3
aws lambda invoke \
  --function-name wiki-rag-ingest \
  --payload '{"action":"ingest","compartment":"TEAM","filePath":"compartments/TEAM/raw/the_hobbit_tolkien.txt"}' \
  --cli-binary-format raw-in-base64-out \
  response.json && cat response.json

# Watch logs live
aws logs tail /aws/lambda/wiki-rag-ingest --follow

# Confirm wiki pages landed in S3
aws s3 ls s3://MY-BUCKET/compartments/TEAM/wiki/ --recursive

# Test auto-trigger: upload a new raw file
aws s3 cp my-doc.pdf s3://MY-BUCKET/compartments/TEAM/raw/my-doc.pdf
# Lambda should fire automatically within seconds
```

---

## Files Modified

| File | Change |
|---|---|
| `client.ts` | Lines 19–20, 188–207: swap Anthropic SDK → Bedrock SDK |
| `config.ts` | Lines 82–83, 90–91: swap model IDs to Bedrock inference profiles |
| `.dockerignore` | New file |
| `s3-trigger.json` | New helper file (used once for S3 notification setup) |
| `task-def.json` | New helper file (used once for ECS task registration) |

---

## Implementation Order

1. Flip `client.ts` + `config.ts`
2. `npx tsc` — verify no compile errors
3. Create `.dockerignore`
4. Create IAM role
5. Create ECR repo + build + push Docker image
6. Deploy Lambda zip
7. Wire S3 trigger
8. Register ECS task definition
9. Run verification commands

---

## Placeholders

Replace these in all commands and JSON:
- `MY-ACCOUNT` — your AWS account ID
- `MY-REGION` — your AWS region (e.g. `us-east-1`)
- `MY-BUCKET` — your S3 bucket name
- `TEAM` — your compartment name (e.g. `tolkien`, `engineering`, `security`)
