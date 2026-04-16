// ─────────────────────────────────────────────────────────────────────────────
// MODEL CLIENT — API-test mode
//
// We're currently testing the pipeline against the direct Anthropic API
// (ANTHROPIC_API_KEY) instead of Bedrock. The two SDKs share an identical
// `messages.create` surface, so swapping them is a one-line change at the
// constructor level — every other call site (ingest/query/lint prompts,
// JSON parsing, error handling) is unchanged.
//
// To switch back to Bedrock for real AWS deployment:
//   1. Comment out the `Anthropic` import below.
//   2. Uncomment the `AnthropicBedrock` import.
//   3. In WikiClient.constructor, comment out `new Anthropic()` and
//      uncomment `new AnthropicBedrock(...)`.
//   4. In config.ts, swap the wikiModel/queryModel defaults back to the
//      Bedrock inference-profile IDs (also marked there).
// ─────────────────────────────────────────────────────────────────────────────

import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk"; // ← Bedrock path (AWS deployment)
// import Anthropic from "@anthropic-ai/sdk"; // ← Anthropic API (test mode, disabled)
import { config } from "./config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface WikiDiff {
  upserts: Record<string, string>; // relativePath -> markdown content
  deletions: string[];
  summary: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA = `
You are the wiki maintainer for a Tolkien knowledge base using the LLM-Wiki pattern.
Your role: build and maintain a persistent, compounding wiki of Tolkien lore as
structured, interlinked markdown files.

DIRECTORY STRUCTURE:
  index.md            — catalog of all pages with one-line summaries
  log.md              — append-only chronological log
  entities/           — named things: characters, places, races, artifacts, events
  concepts/           — abstract ideas: themes, languages, cosmology, magic systems
  sources/            — one summary page per ingested text
  syntheses/          — cross-cutting analyses filed from queries

CROSS-REFERENCE RULES:
  - Use [[PageName]] Obsidian wiki-link syntax for ALL internal links
  - Every entity page links to sources that mention it
  - Every source page links to entities/concepts it introduces
  - Flag contradictions: > ⚠️ CONTRADICTION: ...
  - Tolkien revised his mythology extensively — note canonical vs draft variants

PAGE FRONTMATTER (add to every page):
  ---
  tags: [entity|concept|source|synthesis]
  type: character|place|artifact|race|event|theme|language|cosmology
  aliases: [alternate names]
  ---

OUTPUT FORMAT — respond ONLY with valid JSON, no prose outside it:
{
  "upserts": {
    "<relative path from wiki root e.g. entities/gandalf.md>": "<full markdown>"
  },
  "deletions": ["<relative path>"],
  "summary": "<one paragraph human-readable summary of what changed>"
}
`.trim();

const INGEST_PROMPT = `
${SCHEMA}

EXISTING WIKI STATE:
<index>
{INDEX}
</index>

<recent_log>
{LOG_TAIL}
</recent_log>

SOURCE TO INGEST:
Filename: {FILENAME}
SHA-256: {SHA256}
{CHUNK_HEADER}

<source_content>
{CONTENT}
</source_content>

TASK — integrate this source into the wiki:
1. Create or UPDATE sources/{STEM}.md — a structured summary of this text.
   On chunks after the first, MERGE new material into the existing summary
   rather than overwriting it.
2. Create or UPDATE entity pages for every named character, place, race,
   artifact, and event. Do NOT just list them — synthesize what is known.
   Merge new information into existing pages rather than duplicating.
3. Create or UPDATE concept pages for themes, languages, cosmological ideas.
4. Update index.md to include all new/changed pages.
5. Append to log.md: ## [{DATE}] ingest | {FILENAME}
6. Add cross-references: link new pages to existing ones and vice versa.
7. Note where this source CONTRADICTS or REVISES existing wiki pages.
8. Note canonical vs draft/variant status where relevant.

A typical ingest pass should touch roughly 10–15 wiki pages — enough to
integrate new material across entities, concepts, and the index without
churning the entire wiki on every call.

Do NOT create a page organized around the source document structure.
Extract knowledge into entity and concept pages — the source disappears
into the wiki, leaving only compiled knowledge behind.

If this is a chunk of a larger book, treat it as a continuation: assume
the wiki already reflects earlier chunks, and focus on what is NEW or
REFINED by the material in this chunk.

Respond ONLY with the JSON object.
`.trim();

const QUERY_PROMPT = `
${SCHEMA}

WIKI INDEX (consult this FIRST to decide which pages are relevant):
<index>
{INDEX}
</index>

WIKI PAGES (selected pages follow — you may not have every page here):
<wiki>
{WIKI_CONTEXT}
</wiki>

USER QUESTION:
{QUESTION}

TASK:
- Begin by scanning the index to identify the pages most relevant to the
  question, then synthesize an answer from the wiki content above.
- Cite pages using [[PageName]] Obsidian link syntax.
- If the answer reveals new cross-connections, add them as upserts.
- If this is a significant analysis worth preserving, file it as
  syntheses/<slug>.md so the knowledge compounds — good answers should
  flow back into the wiki.
- If nothing needs updating, set upserts to {} and deletions to [].
- Put the full conversational answer in the "summary" field.

Respond ONLY with the JSON object.
`.trim();

const LINT_PROMPT = `
${SCHEMA}

FULL WIKI CONTEXT:
<wiki>
{WIKI_CONTEXT}
</wiki>

TASK — wiki health check. Find and fix:
1. ORPHAN PAGES — no inbound [[links]]. Add links from related pages.
2. MISSING PAGES — entities/concepts frequently mentioned but lacking own page.
   Create stub pages for the 5 most important missing ones.
3. BROKEN LINKS — [[Links]] pointing to non-existent pages. Fix or remove.
4. CONTRADICTIONS — conflicting claims across pages. Flag with ⚠️ or resolve.
5. STALE CLAIMS — pages that haven't been updated to reflect newer sources.
6. INDEX GAPS — pages missing from index.md. Add them.
7. OBSIDIAN GRAPH HEALTH — ensure enough cross-links for a useful graph view.
   Tolkien's world is deeply interconnected — the graph should show it.
8. MISSING ALIASES — characters with many names (Gandalf/Mithrandir/Olórin)
   should have aliases in frontmatter for Obsidian search.

Append a lint report to log.md:
## [{DATE}] lint | Health Check
... findings ...

Respond ONLY with the JSON object.
`.trim();

// ─────────────────────────────────────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────────────────────────────────────

export class WikiClient {
  // ── Bedrock mode (active — AWS deployment) ────────────────────────────
  private client: AnthropicBedrock;

  constructor() {
    // Authenticates via the AWS credential chain: env vars, shared config,
    // ECS task role, Lambda execution role, or EC2 instance profile. The
    // caller's IAM principal must allow bedrock:InvokeModel on the wiki
    // and query model inference profile ARNs (and their underlying
    // foundation model ARNs in every profile region).
    this.client = new AnthropicBedrock({ awsRegion: config.region });
  }

  // ── API-test mode (disabled) ───────────────────────────────────────────
  //
  // private client: Anthropic;
  //
  // constructor() {
  //   // Direct Anthropic API. Reads ANTHROPIC_API_KEY from the environment.
  //   // Used for end-to-end pipeline testing before Bedrock deployment.
  //   this.client = new Anthropic();
  // }

  private async call(
    prompt: string,
    model: string,
    maxTokens = 32000
  ): Promise<string> {
    // Streaming mode. Three reasons:
    //   1. No overall request timeout — the non-streaming SDK path has a
    //      10-minute cap that big chunks near the 16k-output ceiling can
    //      actually hit under rate-limit backoff.
    //   2. Progress feedback — we print a dot per text delta so the
    //      operator can see the model working instead of staring at a
    //      silent terminal for 3 minutes per chunk.
    //   3. Catches max_tokens truncation via finalMessage().stop_reason
    //      just like the non-streaming path did.
    process.stdout.write("    ");
    const stream = this.client.messages.stream({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    });

    stream.on("text", () => process.stdout.write("."));

    const finalMessage = await stream.finalMessage();
    process.stdout.write("\n");

    if (finalMessage.stop_reason === "max_tokens") {
      throw new Error(
        `Model output truncated at max_tokens=${maxTokens}. ` +
          `The response was cut off before completing. ` +
          `Either lower CHUNK_CHARS (currently ${config.chunkChars}) so each ` +
          `chunk produces a smaller diff, or raise the maxTokens argument in ` +
          `client.ts (Sonnet 4.6 supports up to 64000).`
      );
    }

    const block = finalMessage.content[0];
    if (block.type !== "text") throw new Error("Unexpected response type");
    return block.text;
  }

  private parseDiff(raw: string): WikiDiff {
    // Strip markdown fences if the model wraps the JSON
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "")
      .trim();

    try {
      const parsed = JSON.parse(cleaned) as WikiDiff;
      return {
        upserts: parsed.upserts ?? {},
        deletions: parsed.deletions ?? [],
        summary: parsed.summary ?? "",
      };
    } catch (e) {
      throw new Error(
        `Model returned invalid JSON: ${e}\n\nFirst 500 chars:\n${raw.slice(0, 500)}`
      );
    }
  }

  async ingest(params: {
    filename: string;
    stem: string;
    sha256: string;
    content: string;
    index: string;
    logTail: string;
    date: string;
    chunkIndex?: number;
    chunkTotal?: number;
  }): Promise<WikiDiff> {
    const chunkHeader =
      params.chunkTotal && params.chunkTotal > 1
        ? `Chunk: ${(params.chunkIndex ?? 0) + 1} of ${params.chunkTotal}`
        : "";

    const prompt = INGEST_PROMPT.replace("{INDEX}", params.index || "(empty — first ingest)")
      .replace("{LOG_TAIL}", params.logTail || "(no log yet)")
      .replace(/{FILENAME}/g, params.filename)
      .replace("{SHA256}", params.sha256)
      .replace("{CHUNK_HEADER}", chunkHeader)
      .replace("{CONTENT}", params.content)
      .replace("{STEM}", params.stem)
      .replace(/{DATE}/g, params.date);

    // 32k tokens of output — Opus 4.6's max. Bumped from 16384 after a
    // chunk of The Hobbit truncated mid-diff. The model tends to expand
    // output as the wiki grows (more existing pages to refine), so headroom
    // matters more on later chunks than the first.
    const raw = await this.call(prompt, config.wikiModel, 32000);
    return this.parseDiff(raw);
  }

  async query(
    question: string,
    wikiContext: string,
    index: string
  ): Promise<WikiDiff> {
    const prompt = QUERY_PROMPT.replace("{INDEX}", index || "(empty index)")
      .replace("{WIKI_CONTEXT}", wikiContext)
      .replace("{QUESTION}", question);
    const raw = await this.call(prompt, config.queryModel, 4096);
    return this.parseDiff(raw);
  }

  async lint(wikiContext: string, date: string): Promise<WikiDiff> {
    const prompt = LINT_PROMPT.replace("{WIKI_CONTEXT}", wikiContext).replace(
      /{DATE}/g,
      date
    );
    // Lint can touch many pages at once — give it the same 32k headroom
    // as ingest.
    const raw = await this.call(prompt, config.wikiModel, 32000);
    return this.parseDiff(raw);
  }
}
