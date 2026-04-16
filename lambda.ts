import { WikiEngine } from "./engine.js";
import { config } from "./config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Lambda handler — incremental document updates
//
// Purpose: keep an already-built wiki fresh as new or updated documents
// arrive. Bulk (first-time) ingest runs on Fargate instead — see Dockerfile.
//
// Input shapes supported:
//
// 1. Direct invocation (EventBridge, custom pipelines, manual test):
//    {
//      "action": "ingest" | "query" | "lint",
//      "compartment": "team-security",
//      "filePath": "wikis/team-security/raw/runbook.pdf",   // ingest only
//      "question": "who owns the auth service?",            // query only
//      "force": false                                        // ingest only
//    }
//
// 2. S3 event (wired up later — the trigger is a placeholder for now).
//    The handler extracts bucket+key from the record and ingests that
//    single object into the compartment derived from its key prefix.
//
// A Lambda invocation is single-document. The 15-minute timeout is plenty
// for typical internal docs (runbooks, design docs, tickets). Anything that
// chunks into more than ~5 passes should go through Fargate instead; see
// the Dockerfile entrypoint for bulk ingest.
// ─────────────────────────────────────────────────────────────────────────────

interface DirectEvent {
  action: "ingest" | "query" | "lint";
  compartment?: string;
  filePath?: string;
  question?: string;
  force?: boolean;
  persist?: boolean;
}

interface S3EventRecord {
  s3: {
    bucket: { name: string };
    object: { key: string };
  };
}

interface S3Event {
  Records: S3EventRecord[];
}

type LambdaEvent = DirectEvent | S3Event;

export interface LambdaResponse {
  ok: boolean;
  compartment: string;
  action: string;
  result?: unknown;
  error?: string;
}

/**
 * Derive compartment id from an S3 key. Assumes the convention
 *   {s3KeyPrefix}{compartment}/raw/...
 * so the first path segment after the configured prefix is the team id.
 */
function compartmentFromKey(key: string): string {
  const prefix = config.s3KeyPrefix;
  const stripped = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  const firstSegment = stripped.split("/")[0];
  if (!firstSegment) {
    throw new Error(`Cannot derive compartment from key: ${key}`);
  }
  return firstSegment;
}

function isS3Event(event: LambdaEvent): event is S3Event {
  return Array.isArray((event as S3Event).Records);
}

export async function handler(event: LambdaEvent): Promise<LambdaResponse> {
  try {
    if (isS3Event(event)) {
      // PLACEHOLDER — trigger wiring is deferred. When S3 Put notifications
      // are hooked up, each record lands here. We pick the first and ingest.
      const record = event.Records[0];
      if (!record) {
        return { ok: false, compartment: "", action: "none", error: "Empty S3 event" };
      }
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
      const compartment = compartmentFromKey(key);
      const engine = new WikiEngine(compartment);
      const result = await engine.ingest(key, false);
      return { ok: true, compartment, action: "ingest", result };
    }

    // Direct invocation
    const compartment = event.compartment ?? config.defaultCompartment;
    const engine = new WikiEngine(compartment);

    switch (event.action) {
      case "ingest": {
        if (!event.filePath) {
          return {
            ok: false,
            compartment,
            action: "ingest",
            error: "filePath is required for ingest",
          };
        }
        const result = await engine.ingest(event.filePath, event.force ?? false);
        return { ok: true, compartment, action: "ingest", result };
      }
      case "query": {
        if (!event.question) {
          return {
            ok: false,
            compartment,
            action: "query",
            error: "question is required for query",
          };
        }
        const result = await engine.query(event.question, event.persist ?? true);
        return { ok: true, compartment, action: "query", result };
      }
      case "lint": {
        const result = await engine.lint();
        return { ok: true, compartment, action: "lint", result };
      }
      default:
        return {
          ok: false,
          compartment,
          action: String(event.action ?? "unknown"),
          error: `Unknown action: ${String(event.action)}`,
        };
    }
  } catch (e) {
    return {
      ok: false,
      compartment: "",
      action: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
