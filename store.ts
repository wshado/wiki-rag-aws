import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { config } from "./config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SourceFile {
  filePath: string; // opaque identifier — a local path or an s3:// URI
  name: string;
  stem: string;
  ext: string;
  content: string;
  sha256: string;
  sizeBytes: number;
}

export interface WikiPage {
  relativePath: string; // relative to the compartment's wiki root
  name: string;
  content: string;
}

export interface IngestRecord {
  sha256: string;
  ingestedAt: string;
  pagesTouched: string[];
  // ── Per-chunk checkpoint fields (added after the Hobbit timeout incident)
  // Legacy records predating checkpointing have none of these set and are
  // treated as complete for backward compatibility.
  status?: "in_progress" | "complete";
  chunksCompleted?: number;
  chunksTotal?: number;
}

export type IngestRegistry = Record<string, IngestRecord>;

export type ResumeDecision =
  | { action: "skip"; reason: string }
  | { action: "resume"; fromChunk: number; prevPages: string[] }
  | { action: "fresh"; reason?: string };

/**
 * Given the current registry and the file we're about to ingest, decide
 * whether to skip (already complete), resume partway through, or start fresh.
 *
 * The caller is expected to have already chunked the source — pass
 * `currentChunksTotal` so we can detect if CHUNK_CHARS changed since the
 * last run (in which case resume is unsafe and we restart).
 */
export function getResumePoint(
  registry: IngestRegistry,
  filePath: string,
  sha256: string,
  currentChunksTotal: number
): ResumeDecision {
  const rec = registry[filePath];
  if (!rec) return { action: "fresh" };
  if (rec.sha256 !== sha256) {
    return { action: "fresh", reason: "source file changed (SHA-256 differs)" };
  }
  // Legacy: no status field → treat as complete
  if (!rec.status || rec.status === "complete") {
    return { action: "skip", reason: "Already ingested (SHA-256 match)" };
  }
  // In progress — check chunk compatibility
  if (rec.chunksTotal !== currentChunksTotal) {
    return {
      action: "fresh",
      reason: `chunk layout changed (was ${rec.chunksTotal}, now ${currentChunksTotal}) — CHUNK_CHARS probably changed`,
    };
  }
  return {
    action: "resume",
    fromChunk: rec.chunksCompleted ?? 0,
    prevPages: rec.pagesTouched,
  };
}

/**
 * Write a checkpoint to the registry after a chunk completes. The status
 * flips to "complete" automatically when chunksCompleted === chunksTotal.
 */
export function markChunkComplete(
  registry: IngestRegistry,
  filePath: string,
  sha256: string,
  chunksCompleted: number,
  chunksTotal: number,
  pagesTouched: string[]
): void {
  registry[filePath] = {
    sha256,
    ingestedAt: new Date().toISOString(),
    pagesTouched,
    status: chunksCompleted >= chunksTotal ? "complete" : "in_progress",
    chunksCompleted,
    chunksTotal,
  };
}

export interface SourceChunk {
  index: number; // 0-based
  total: number;
  content: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store interface
//
// Every call is scoped to a compartment (team). Implementations treat the
// compartment id as the top-level namespace: local dirs use it as a subfolder,
// S3 uses it as a key prefix. The engine only ever speaks in relative paths
// like "entities/gandalf.md" — the store handles prefixing.
// ─────────────────────────────────────────────────────────────────────────────

export interface Store {
  readonly compartment: string;

  // Raw sources (input layer)
  listSourceFiles(): Promise<string[]>; // returns opaque identifiers
  readSourceFile(id: string, maxChars: number): Promise<SourceFile>;

  // Wiki pages
  readWikiPage(relativePath: string): Promise<string | null>;
  writeWikiPage(relativePath: string, content: string): Promise<void>;
  deleteWikiPage(relativePath: string): Promise<void>;
  wikiPageExists(relativePath: string): Promise<boolean>;
  listWikiPages(): Promise<WikiPage[]>;
  readWikiAsContext(maxPages: number): Promise<string>;

  // Special pages
  readIndex(): Promise<string>;
  readLogTail(chars?: number): Promise<string>;
  // CONCURRENCY: S3 has no atomic append. Two simultaneous appendLog calls
  // on the same compartment can clobber each other. Fine for human-driven
  // ingest cadence; revisit if concurrent Lambda invocations become a thing
  // (move log.md + registry to DynamoDB).
  appendLog(entry: string): Promise<void>;

  // Registry
  loadRegistry(): Promise<IngestRegistry>;
  saveRegistry(registry: IngestRegistry): Promise<void>;

  // Cleanup
  deleteAllWiki(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers — backend-agnostic
// ─────────────────────────────────────────────────────────────────────────────

export function chunkSource(
  text: string,
  chunkChars: number,
  overlap: number
): SourceChunk[] {
  if (text.length <= chunkChars) {
    return [{ index: 0, total: 1, content: text }];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + chunkChars, text.length);

    // Snap to nearest paragraph break within the last 2k chars of the window
    if (end < text.length) {
      const windowStart = Math.max(end - 2_000, start + 1);
      const slice = text.slice(windowStart, end);
      const lastBreak = slice.lastIndexOf("\n\n");
      if (lastBreak !== -1) end = windowStart + lastBreak;
    }

    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks.map((content, i) => ({ index: i, total: chunks.length, content }));
}

async function extractPdf(buffer: Buffer): Promise<string> {
  try {
    const mod = await import("pdf-parse");
    const pdfParse = (mod as { default: (b: Buffer) => Promise<{ text: string }> }).default;
    const data = await pdfParse(buffer);
    return data.text;
  } catch (e) {
    return `[PDF extraction failed: ${e instanceof Error ? e.message : String(e)}]`;
  }
}

async function bufferToSource(
  id: string,
  name: string,
  buffer: Buffer,
  maxChars: number
): Promise<SourceFile> {
  const ext = path.extname(name).toLowerCase();
  const stem = path.basename(name, ext);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  let content = ext === ".pdf" ? await extractPdf(buffer) : buffer.toString("utf-8");

  if (content.length > maxChars) {
    content =
      content.slice(0, maxChars) +
      `\n\n[... TRUNCATED at ${maxChars} characters ...]`;
  }

  return { filePath: id, name, stem, ext, content, sha256, sizeBytes: buffer.length };
}

export function isAlreadyIngested(
  registry: IngestRegistry,
  filePath: string,
  sha256: string
): boolean {
  return registry[filePath]?.sha256 === sha256;
}

export function markIngested(
  registry: IngestRegistry,
  filePath: string,
  sha256: string,
  pagesTouched: string[]
): void {
  registry[filePath] = {
    sha256,
    ingestedAt: new Date().toISOString(),
    pagesTouched,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LocalStore — scratch testing / development
//
// Layout under config.localRoot:
//   {compartment}/raw/...          — input
//   {compartment}/wiki/...         — output
//   {compartment}/wiki/meta/...    — registry
// ─────────────────────────────────────────────────────────────────────────────

export class LocalStore implements Store {
  readonly compartment: string;
  private readonly rawDir: string;
  private readonly wikiDir: string;

  constructor(compartment: string) {
    this.compartment = compartment;
    const root = config.localRoot;
    this.rawDir = path.join(root, compartment, "raw");
    this.wikiDir = path.join(root, compartment, "wiki");
    fs.mkdirSync(this.rawDir, { recursive: true });
    fs.mkdirSync(this.wikiDir, { recursive: true });
    fs.mkdirSync(path.join(this.wikiDir, "meta"), { recursive: true });
  }

  private abs(relativePath: string): string {
    return path.join(this.wikiDir, relativePath);
  }

  async listSourceFiles(): Promise<string[]> {
    if (!fs.existsSync(this.rawDir)) return [];
    return fs
      .readdirSync(this.rawDir)
      .filter((f) => [".txt", ".md", ".pdf"].includes(path.extname(f).toLowerCase()))
      .map((f) => path.join(this.rawDir, f))
      .sort();
  }

  async readSourceFile(filePath: string, maxChars: number): Promise<SourceFile> {
    const buffer = fs.readFileSync(filePath);
    return bufferToSource(filePath, path.basename(filePath), buffer, maxChars);
  }

  async readWikiPage(relativePath: string): Promise<string | null> {
    const full = this.abs(relativePath);
    if (!fs.existsSync(full)) return null;
    return fs.readFileSync(full, "utf-8");
  }

  async writeWikiPage(relativePath: string, content: string): Promise<void> {
    const full = this.abs(relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
  }

  async deleteWikiPage(relativePath: string): Promise<void> {
    const full = this.abs(relativePath);
    if (fs.existsSync(full)) fs.unlinkSync(full);
  }

  async wikiPageExists(relativePath: string): Promise<boolean> {
    return fs.existsSync(this.abs(relativePath));
  }

  async listWikiPages(): Promise<WikiPage[]> {
    if (!fs.existsSync(this.wikiDir)) return [];
    const results: WikiPage[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "meta") walk(full);
        } else if (entry.name.endsWith(".md")) {
          const relativePath = path.relative(this.wikiDir, full).replace(/\\/g, "/");
          results.push({
            relativePath,
            name: path.basename(full, ".md"),
            content: fs.readFileSync(full, "utf-8"),
          });
        }
      }
    };
    walk(this.wikiDir);
    return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  async readWikiAsContext(maxPages: number): Promise<string> {
    const pages = (await this.listWikiPages()).slice(0, maxPages);
    return pages
      .map((p) => `<!-- PAGE: ${p.relativePath} -->\n${p.content}`)
      .join("\n\n---\n\n");
  }

  async readIndex(): Promise<string> {
    return (await this.readWikiPage("index.md")) ?? "";
  }

  async readLogTail(chars = 4000): Promise<string> {
    const log = await this.readWikiPage("log.md");
    return log ? log.slice(-chars) : "";
  }

  async appendLog(entry: string): Promise<void> {
    const existing = (await this.readWikiPage("log.md")) ?? "";
    const ts = new Date().toISOString().slice(0, 10);
    await this.writeWikiPage("log.md", existing + `\n## [${ts}] ${entry}\n`);
  }

  async loadRegistry(): Promise<IngestRegistry> {
    const raw = await this.readWikiPage("meta/ingested.json");
    if (!raw) return {};
    try {
      return JSON.parse(raw) as IngestRegistry;
    } catch {
      return {};
    }
  }

  async saveRegistry(registry: IngestRegistry): Promise<void> {
    await this.writeWikiPage("meta/ingested.json", JSON.stringify(registry, null, 2));
  }

  async deleteAllWiki(): Promise<void> {
    if (fs.existsSync(this.wikiDir)) {
      fs.rmSync(this.wikiDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.wikiDir, { recursive: true });
    fs.mkdirSync(path.join(this.wikiDir, "meta"), { recursive: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// S3Store — AWS deployment
//
// Layout in config.s3Bucket:
//   {keyPrefix}{compartment}/raw/...     — input
//   {keyPrefix}{compartment}/wiki/...    — output
//   {keyPrefix}{compartment}/wiki/meta/ingested.json
//
// keyPrefix is optional (e.g. "wikis/"). The compartment id is always the
// next path segment, so IAM policies can grant access per-team by prefix.
// ─────────────────────────────────────────────────────────────────────────────

export class S3Store implements Store {
  readonly compartment: string;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly rawPrefix: string;
  private readonly wikiPrefix: string;

  constructor(compartment: string) {
    if (!config.s3Bucket) {
      throw new Error("S3Store requires config.s3Bucket (set S3_BUCKET env var)");
    }
    this.compartment = compartment;
    this.client = new S3Client({ region: config.region });
    this.bucket = config.s3Bucket;
    const base = `${config.s3KeyPrefix}${compartment}`;
    this.rawPrefix = `${base}/raw/`;
    this.wikiPrefix = `${base}/wiki/`;
  }

  private wikiKey(relativePath: string): string {
    return this.wikiPrefix + relativePath;
  }

  private async getObjectText(key: string): Promise<string | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key })
      );
      const body = await res.Body?.transformToString("utf-8");
      return body ?? null;
    } catch (e) {
      if ((e as { name?: string }).name === "NoSuchKey") return null;
      throw e;
    }
  }

  private async getObjectBuffer(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key })
    );
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Empty object: ${key}`);
    return Buffer.from(bytes);
  }

  private async putObject(key: string, content: string | Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: content,
        ContentType: key.endsWith(".md")
          ? "text/markdown"
          : key.endsWith(".json")
          ? "application/json"
          : "application/octet-stream",
      })
    );
  }

  private async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      continuationToken = res.NextContinuationToken;
    } while (continuationToken);
    return keys;
  }

  async listSourceFiles(): Promise<string[]> {
    const keys = await this.listKeys(this.rawPrefix);
    return keys
      .filter((k) => {
        const ext = path.extname(k).toLowerCase();
        return [".txt", ".md", ".pdf"].includes(ext);
      })
      .sort();
  }

  async readSourceFile(key: string, maxChars: number): Promise<SourceFile> {
    const buffer = await this.getObjectBuffer(key);
    const name = path.basename(key);
    return bufferToSource(key, name, buffer, maxChars);
  }

  async readWikiPage(relativePath: string): Promise<string | null> {
    return this.getObjectText(this.wikiKey(relativePath));
  }

  async writeWikiPage(relativePath: string, content: string): Promise<void> {
    await this.putObject(this.wikiKey(relativePath), content);
  }

  async deleteWikiPage(relativePath: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: this.wikiKey(relativePath),
        })
      );
    } catch (e) {
      if ((e as { name?: string }).name !== "NoSuchKey") throw e;
    }
  }

  async wikiPageExists(relativePath: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.wikiKey(relativePath) })
      );
      return true;
    } catch {
      return false;
    }
  }

  async listWikiPages(): Promise<WikiPage[]> {
    const keys = await this.listKeys(this.wikiPrefix);
    const mdKeys = keys.filter(
      (k) => k.endsWith(".md") && !k.startsWith(this.wikiPrefix + "meta/")
    );

    const pages: WikiPage[] = [];
    // Fetch in parallel batches of 20 to limit memory/connections
    const batchSize = 20;
    for (let i = 0; i < mdKeys.length; i += batchSize) {
      const batch = mdKeys.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (key) => {
          const content = (await this.getObjectText(key)) ?? "";
          const relativePath = key.slice(this.wikiPrefix.length);
          return {
            relativePath,
            name: path.basename(key, ".md"),
            content,
          };
        })
      );
      pages.push(...results);
    }
    return pages.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  async readWikiAsContext(maxPages: number): Promise<string> {
    const pages = (await this.listWikiPages()).slice(0, maxPages);
    return pages
      .map((p) => `<!-- PAGE: ${p.relativePath} -->\n${p.content}`)
      .join("\n\n---\n\n");
  }

  async readIndex(): Promise<string> {
    return (await this.readWikiPage("index.md")) ?? "";
  }

  async readLogTail(chars = 4000): Promise<string> {
    const log = await this.readWikiPage("log.md");
    return log ? log.slice(-chars) : "";
  }

  async appendLog(entry: string): Promise<void> {
    // CONCURRENCY: read-modify-write. Last writer wins on collision.
    const existing = (await this.readWikiPage("log.md")) ?? "";
    const ts = new Date().toISOString().slice(0, 10);
    await this.writeWikiPage("log.md", existing + `\n## [${ts}] ${entry}\n`);
  }

  async loadRegistry(): Promise<IngestRegistry> {
    const raw = await this.readWikiPage("meta/ingested.json");
    if (!raw) return {};
    try {
      return JSON.parse(raw) as IngestRegistry;
    } catch {
      return {};
    }
  }

  async saveRegistry(registry: IngestRegistry): Promise<void> {
    await this.writeWikiPage("meta/ingested.json", JSON.stringify(registry, null, 2));
  }

  async deleteAllWiki(): Promise<void> {
    const keys = await this.listKeys(this.wikiPrefix);
    for (const key of keys) {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createStore(compartment: string): Store {
  if (config.storeBackend === "s3") {
    return new S3Store(compartment);
  }
  return new LocalStore(compartment);
}
