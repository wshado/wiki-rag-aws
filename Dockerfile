# syntax=docker/dockerfile:1.6
#
# Fargate bulk-ingest image.
#
# Purpose: first-time wiki builds and any ingest that won't fit in Lambda's
# 15-minute window. Run it as a Fargate task triggered by EventBridge / Step
# Functions / manual invocation.
#
# Task definition should set:
#   COMPARTMENT=<team-id>
#   STORE_BACKEND=s3
#   S3_BUCKET=<bucket>
#   S3_KEY_PREFIX=wikis/
#   AWS_REGION=<region>
#   BEDROCK_WIKI_MODEL=us.anthropic.claude-opus-4-6-20251101-v1:0
# and the task role must allow:
#   - bedrock:InvokeModel on the wiki + query model ARNs
#   - s3:GetObject / PutObject / DeleteObject / ListBucket on the bucket+prefix
#
# The default command runs `ingest --all`. Override with a task-definition
# command override to run status / query / lint / clean.

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json* tsconfig.json ./
RUN npm install --omit=dev=false

COPY *.ts ./

# Transpile to plain JS so the runtime image doesn't need tsx
RUN npx tsc

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Copy production deps only
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Default: bulk-ingest every pending source for $COMPARTMENT
ENTRYPOINT ["node", "dist/index.js"]
CMD ["ingest", "--all"]
