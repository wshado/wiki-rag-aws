import path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Config
//
// Everything is env-driven so the same bundle runs locally, in a Fargate
// container, and in a Lambda. Sensible defaults keep local dev frictionless.
// ─────────────────────────────────────────────────────────────────────────────

export type StoreBackend = "local" | "s3";

export interface WikiConfig {
  // Which store implementation to use.
  // "local" — reads/writes under localRoot (dev, scratch Tolkien testing)
  // "s3"    — reads/writes under s3Bucket (AWS deployment)
  storeBackend: StoreBackend;

  // Default compartment (team id). Can be overridden per-request by the
  // CLI (--compartment flag) or the Lambda handler (event payload).
  defaultCompartment: string;

  // ── Local backend ────────────────────────────────────────────────────────
  // Root directory under which compartments live:
  //   {localRoot}/{compartment}/raw/...
  //   {localRoot}/{compartment}/wiki/...
  // For scratch Tolkien testing, the "tolkien" compartment is pre-populated
  // via a symlink/copy of the repo's raw/ folder (see README).
  localRoot: string;

  // ── S3 backend ───────────────────────────────────────────────────────────
  s3Bucket: string | undefined;
  // Optional prefix prepended to every key (e.g. "wikis/"). Must end with /.
  s3KeyPrefix: string;

  // ── AWS / Bedrock ────────────────────────────────────────────────────────
  region: string;

  // Bedrock inference profile for wiki maintenance (ingest/lint).
  // Cross-region inference profiles look like "us.anthropic.claude-opus-4-..."
  // and require the caller's IAM role to allow bedrock:InvokeModel on the
  // profile ARN + the underlying foundation model ARNs.
  wikiModel: string;

  // Model for interactive query answering. Can be a cheaper Sonnet/Haiku.
  queryModel: string;

  // ── Limits ───────────────────────────────────────────────────────────────
  maxSourceChars: number;
  chunkChars: number;
  chunkOverlap: number;
  maxWikiPages: number;
}

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function envRequired(name: string): string | undefined {
  // Returns undefined rather than throwing so local dev can skip AWS vars
  return env(name);
}

export const config: WikiConfig = {
  storeBackend: (env("STORE_BACKEND", "local") as StoreBackend),
  defaultCompartment: env("COMPARTMENT", "tolkien")!,

  localRoot: env("LOCAL_ROOT", path.join(process.cwd(), "compartments"))!,

  s3Bucket: envRequired("S3_BUCKET"),
  s3KeyPrefix: (() => {
    const p = env("S3_KEY_PREFIX", "");
    if (!p) return "";
    return p.endsWith("/") ? p : p + "/";
  })()!,

  region: env("AWS_REGION", "us-east-1")!,

  // ── Bedrock mode (active — AWS deployment) ──────────────────────────
  // Cross-region inference profiles for Claude 4.6 via the us-* profile.
  // Override via env for other regions.
  wikiModel: env("BEDROCK_WIKI_MODEL", "us.anthropic.claude-opus-4-7")!,
  queryModel: env("BEDROCK_QUERY_MODEL", "us.anthropic.claude-sonnet-4-6")!,

  // ── API-test mode (disabled) ─────────────────────────────────────────
  // Direct Anthropic API model IDs. Used while testing the pipeline
  // against ANTHROPIC_API_KEY before Bedrock deployment.
  //
  // wikiModel: env("WIKI_MODEL", "claude-sonnet-4-6")!,
  // queryModel: env("QUERY_MODEL", "claude-sonnet-4-6")!,

  maxSourceChars: Number(env("MAX_SOURCE_CHARS", "4000000")),
  chunkChars: Number(env("CHUNK_CHARS", "80000")),
  chunkOverlap: Number(env("CHUNK_OVERLAP", "2000")),
  maxWikiPages: Number(env("MAX_WIKI_PAGES", "150")),
};
