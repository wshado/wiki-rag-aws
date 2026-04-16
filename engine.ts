import path from "path";
import {
  Store,
  createStore,
  chunkSource,
  getResumePoint,
  markChunkComplete,
} from "./store.js";
import { WikiClient, WikiDiff } from "./client.js";
import { config } from "./config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

export interface IngestResult {
  filePath: string;
  skipped: boolean;
  reason: string;
  pagesUpserted: string[];
  pagesDeleted: string[];
  summary: string;
}

export interface QueryResult {
  question: string;
  answer: string;
  pagesUpserted: string[];
}

export interface LintResult {
  pagesUpserted: string[];
  pagesDeleted: string[];
  report: string;
}

export interface StatusResult {
  backend: string;
  compartment: string;
  sourceFiles: number;
  wikiPages: number;
  ingestedCount: number;
  pendingFiles: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine
//
// One engine instance == one team's wiki. Spin up a fresh engine per
// request/invocation; they're cheap (constructor just wires the Bedrock
// client and the Store, both are thin wrappers).
// ─────────────────────────────────────────────────────────────────────────────

export class WikiEngine {
  private readonly client: WikiClient;
  private readonly store: Store;
  readonly compartment: string;

  constructor(compartment: string = config.defaultCompartment) {
    this.compartment = compartment;
    this.client = new WikiClient();
    this.store = createStore(compartment);
  }

  /**
   * Write a default CLAUDE.md schema for this compartment if one doesn't
   * already exist. Safe to call on every engine construction — it's a no-op
   * after first use.
   */
  async ensureSchema(schema: string = DEFAULT_SCHEMA): Promise<void> {
    if (!(await this.store.wikiPageExists("CLAUDE.md"))) {
      await this.store.writeWikiPage("CLAUDE.md", schema);
    }
  }

  // ── Apply diff ────────────────────────────────────────────────────────────

  private async applyDiff(
    diff: WikiDiff
  ): Promise<{ upserted: string[]; deleted: string[] }> {
    const upserted: string[] = [];
    const deleted: string[] = [];

    for (const [relPath, content] of Object.entries(diff.upserts)) {
      await this.store.writeWikiPage(relPath, content);
      upserted.push(relPath);
    }

    for (const relPath of diff.deletions) {
      await this.store.deleteWikiPage(relPath);
      deleted.push(relPath);
    }

    return { upserted, deleted };
  }

  // ── INGEST ────────────────────────────────────────────────────────────────

  async ingest(filePath: string, force = false): Promise<IngestResult> {
    await this.ensureSchema();

    const registry = await this.store.loadRegistry();
    const source = await this.store.readSourceFile(filePath, config.maxSourceChars);

    // Long documents (books, multi-chapter runbooks) can exceed a single
    // model context. We split into overlapping chunks and run an ingest
    // pass per chunk; each pass sees the wiki state produced by the
    // previous pass, so entity pages refine progressively.
    const chunks = chunkSource(source.content, config.chunkChars, config.chunkOverlap);

    // Decide whether to skip, resume, or start fresh. `force` bypasses
    // resume entirely and re-processes from chunk 0.
    let startChunk = 0;
    const allUpserted = new Set<string>();

    if (!force) {
      const decision = getResumePoint(registry, filePath, source.sha256, chunks.length);
      if (decision.action === "skip") {
        return {
          filePath,
          skipped: true,
          reason: `${decision.reason}. Use force to re-ingest.`,
          pagesUpserted: [],
          pagesDeleted: [],
          summary: "",
        };
      }
      if (decision.action === "resume") {
        startChunk = decision.fromChunk;
        decision.prevPages.forEach((p) => allUpserted.add(p));
        console.log(
          `  [resume] continuing from chunk ${startChunk + 1}/${chunks.length} ` +
            `(${decision.prevPages.length} pages already touched)`
        );
      } else if (decision.reason) {
        console.log(`  [fresh] ${decision.reason}`);
      }
    }

    const date = new Date().toISOString().slice(0, 10);
    const allDeleted = new Set<string>();
    const chunkSummaries: string[] = [];

    for (let i = startChunk; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunks.length > 1) {
        console.log(`  [chunk ${chunk.index + 1}/${chunks.length}] calling model...`);
      } else {
        console.log(`  [single pass] calling model...`);
      }
      const diff = await this.client.ingest({
        filename: source.name,
        stem: source.stem,
        sha256: source.sha256,
        content: chunk.content,
        index: await this.store.readIndex(),
        logTail: await this.store.readLogTail(),
        date,
        chunkIndex: chunk.index,
        chunkTotal: chunk.total,
      });

      const { upserted, deleted } = await this.applyDiff(diff);
      upserted.forEach((p) => allUpserted.add(p));
      deleted.forEach((p) => allDeleted.add(p));
      console.log(
        `    -> ${upserted.length} upserts, ${deleted.length} deletes`
      );
      chunkSummaries.push(
        chunk.total > 1
          ? `[chunk ${chunk.index + 1}/${chunk.total}] ${diff.summary}`
          : diff.summary
      );

      // Checkpoint: persist registry state after every chunk so a crash
      // or timeout on a later chunk doesn't force re-processing this one.
      // markChunkComplete flips status to "complete" automatically when
      // i + 1 === chunks.length.
      markChunkComplete(
        registry,
        filePath,
        source.sha256,
        i + 1,
        chunks.length,
        Array.from(allUpserted)
      );
      await this.store.saveRegistry(registry);

      if (chunk.total > 1) {
        await this.store.appendLog(
          `ingest | ${source.name} chunk ${chunk.index + 1}/${chunk.total} | ${upserted.length} pages touched`
        );
      }
    }

    const upsertedList = Array.from(allUpserted);
    await this.store.appendLog(
      `ingest | ${source.name} | ${upsertedList.length} pages touched (${chunks.length} chunk${chunks.length === 1 ? "" : "s"})`
    );

    return {
      filePath,
      skipped: false,
      reason: `Ingested successfully (${chunks.length} chunk${chunks.length === 1 ? "" : "s"}).`,
      pagesUpserted: upsertedList,
      pagesDeleted: Array.from(allDeleted),
      summary: chunkSummaries.join("\n\n"),
    };
  }

  async ingestAll(force = false): Promise<IngestResult[]> {
    const files = await this.store.listSourceFiles();
    const results: IngestResult[] = [];
    for (const f of files) {
      results.push(await this.ingest(f, force));
    }
    return results;
  }

  // ── QUERY ─────────────────────────────────────────────────────────────────

  async query(question: string, persistSynthesis = true): Promise<QueryResult> {
    const wikiContext = await this.store.readWikiAsContext(config.maxWikiPages);
    const diff = await this.client.query(
      question,
      wikiContext,
      await this.store.readIndex()
    );

    let upserted: string[] = [];
    if (persistSynthesis && Object.keys(diff.upserts).length > 0) {
      const result = await this.applyDiff(diff);
      upserted = result.upserted;
      if (upserted.length > 0) {
        await this.store.appendLog(
          `query | ${question.slice(0, 60)} | filed ${upserted.length} pages`
        );
      }
    }

    return { question, answer: diff.summary, pagesUpserted: upserted };
  }

  // ── LINT ──────────────────────────────────────────────────────────────────

  async lint(): Promise<LintResult> {
    const wikiContext = await this.store.readWikiAsContext(config.maxWikiPages);
    const date = new Date().toISOString().slice(0, 10);
    const diff = await this.client.lint(wikiContext, date);
    const { upserted, deleted } = await this.applyDiff(diff);
    return { pagesUpserted: upserted, pagesDeleted: deleted, report: diff.summary };
  }

  // ── STATUS ────────────────────────────────────────────────────────────────

  async status(): Promise<StatusResult> {
    const [registry, sourceFiles, wikiPages] = await Promise.all([
      this.store.loadRegistry(),
      this.store.listSourceFiles(),
      this.store.listWikiPages(),
    ]);
    const pending = sourceFiles.filter((f) => !registry[f]);

    return {
      backend: config.storeBackend,
      compartment: this.compartment,
      sourceFiles: sourceFiles.length,
      wikiPages: wikiPages.length,
      ingestedCount: Object.keys(registry).length,
      pendingFiles: pending.map((f) => path.basename(f)),
    };
  }

  // ── CLEAN ─────────────────────────────────────────────────────────────────

  async clean(): Promise<void> {
    await this.store.deleteAllWiki();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default schema — written to each new compartment's CLAUDE.md on first run.
//
// This is the generic internal-docs schema. Teams can edit their own
// CLAUDE.md afterwards (e.g. to add domain-specific entity types) and
// subsequent ingests will pick up the edits automatically via readWiki.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SCHEMA = `---
tags: [schema]
---

# Team Wiki Schema

This wiki uses Karpathy's LLM-Wiki pattern
(https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).
An LLM maintains it: you add raw documents, the LLM compiles them into a
structured, interlinked markdown knowledge base.

## Three Layers

- **Raw sources** — immutable documents uploaded to \`raw/\` (PDFs, markdown,
  text exports from Confluence / SharePoint / wiki / tickets).
- **Wiki** — LLM-maintained markdown pages in this directory tree.
- **Schema** — this file. Defines conventions and entity/concept types.

## Directory Structure

\`\`\`
entities/     Named things — people, services, systems, teams, projects
concepts/     Abstract ideas — processes, policies, architectures, conventions
sources/      One summary page per ingested document
syntheses/    Cross-cutting analyses filed from significant query answers
index.md      Content-oriented catalog organised by category
log.md        Append-only chronological record of ingests, queries, lints
\`\`\`

## Entity Types (customise for your team)

- **People** — contributors, owners, stakeholders
- **Services** — internal APIs, microservices, deployed systems
- **Systems** — infrastructure, databases, third-party integrations
- **Projects** — initiatives, epics, ongoing workstreams
- **Teams** — other teams you interact with

## Concept Types (customise for your team)

- **Processes** — how we do things (incident response, on-call, deployment)
- **Policies** — what we require (compliance, review gates, data handling)
- **Architectures** — design patterns, system diagrams, data flow
- **Conventions** — coding style, naming, tooling choices
- **Decisions** — ADRs, trade-offs, historical context

## Cross-Reference Rules

- Every internal link uses \`[[PageName]]\` Obsidian/wiki-link syntax.
- Every entity page lists the sources that mention it.
- Every source page lists the entities and concepts it introduces.
- Flag contradictions with \`> ⚠️ CONTRADICTION:\`.
- Flag stale claims with \`> 🕰️ STALE:\` when a newer source supersedes them.

## Page Frontmatter

Add to every page:

\`\`\`yaml
---
tags: [entity|concept|source|synthesis]
type: person|service|system|project|process|policy|architecture|decision
aliases: [alternate names]
---
\`\`\`

## Editing This Schema

You can edit this file freely. The next ingest pass will read it and follow
your updated conventions. Use it to encode team-specific vocabulary, naming
rules, or priorities.
`.trim();
