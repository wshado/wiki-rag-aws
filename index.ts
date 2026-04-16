#!/usr/bin/env node

import { Command } from "commander";
import readline from "readline";
import { WikiEngine } from "./engine.js";
import { config } from "./config.js";

// ─────────────────────────────────────────────────────────────────────────────
// CLI
//
// Runs locally for scratch testing and also inside the Fargate container
// (the Dockerfile's entrypoint invokes this file). All commands accept a
// --compartment flag that overrides the COMPARTMENT env var for this run.
// ─────────────────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(msg);
}

function logSection(title: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

function logResult(label: string, value: string | number) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

interface GlobalOpts {
  compartment?: string;
}

function engineFromOpts(cmd: Command): WikiEngine {
  const globals = cmd.optsWithGlobals<GlobalOpts>();
  return new WikiEngine(globals.compartment ?? config.defaultCompartment);
}

const program = new Command();

program
  .name("wiki")
  .description(
    "LLM-Wiki generator — compartmentalised per team, backed by Bedrock + S3 (or local fs)"
  )
  .version("1.0.0")
  .option(
    "-c, --compartment <id>",
    "Team/compartment id (overrides COMPARTMENT env var)"
  );

// ── status ───────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show wiki status for this compartment")
  .action(async (_opts, cmd) => {
    const engine = engineFromOpts(cmd);
    const s = await engine.status();
    logSection("Wiki Status");
    logResult("Backend:", s.backend);
    logResult("Compartment:", s.compartment);
    logResult("Source files:", s.sourceFiles);
    logResult("Wiki pages:", s.wikiPages);
    logResult("Ingested:", s.ingestedCount);
    if (s.pendingFiles.length > 0) {
      log(`\n  Pending ingest (${s.pendingFiles.length}):`);
      s.pendingFiles.forEach((f) => log(`    - ${f}`));
    } else {
      log("\n  All source files ingested.");
    }
    log("");
  });

// ── ingest ───────────────────────────────────────────────────────────────────

program
  .command("ingest [file]")
  .description("Ingest a source file. Omit [file] to ingest all pending.")
  .option("-a, --all", "Ingest all source files")
  .option("-f, --force", "Re-ingest even if SHA-256 matches")
  .action(
    async (
      file: string | undefined,
      opts: { all?: boolean; force?: boolean },
      cmd: Command
    ) => {
      const engine = engineFromOpts(cmd);

      if (opts.all || !file) {
        logSection(`Ingesting all pending sources (${engine.compartment})`);
        const results = await engine.ingestAll(opts.force ?? false);

        let ok = 0;
        let skipped = 0;
        for (const r of results) {
          const name = r.filePath.split(/[/\\]/).pop() ?? r.filePath;
          if (r.skipped) {
            log(`  [SKIP] ${name} — ${r.reason}`);
            skipped++;
          } else {
            log(`  [ OK ] ${name}`);
            log(
              `         Pages: ${r.pagesUpserted.length} upserted, ${r.pagesDeleted.length} deleted`
            );
            if (r.summary) {
              log(`         ${r.summary.slice(0, 120)}...`);
            }
            ok++;
          }
        }

        log("");
        log(`  Done. Ingested: ${ok}  Skipped: ${skipped}  Total: ${results.length}`);
        log("");
      } else {
        logSection(`Ingesting: ${file} (${engine.compartment})`);
        const result = await engine.ingest(file, opts.force ?? false);

        if (result.skipped) {
          log(`  SKIPPED: ${result.reason}`);
        } else {
          log(`  OK: ${result.reason}`);
          log(`  Pages upserted: ${result.pagesUpserted.length}`);
          result.pagesUpserted.slice(0, 10).forEach((p) => log(`    + ${p}`));
          if (result.pagesUpserted.length > 10) {
            log(`    ... and ${result.pagesUpserted.length - 10} more`);
          }
          log(`\n  Summary:\n  ${result.summary}`);
        }
        log("");
      }
    }
  );

// ── query ────────────────────────────────────────────────────────────────────

program
  .command("query [question]")
  .description("Ask a question against the wiki. Omit question for interactive mode.")
  .option("--no-persist", "Don't file the answer back into the wiki")
  .action(async (question: string | undefined, opts: { persist: boolean }, cmd: Command) => {
    const engine = engineFromOpts(cmd);

    if (question) {
      logSection(`Query: ${question} (${engine.compartment})`);
      log("  Thinking...\n");
      const result = await engine.query(question, opts.persist);
      log(`${"─".repeat(60)}`);
      log(result.answer);
      log(`${"─".repeat(60)}`);
      if (result.pagesUpserted.length > 0) {
        log(`\n  Filed to wiki: ${result.pagesUpserted.join(", ")}`);
      }
      log("");
    } else {
      logSection(`Interactive Query Mode (${engine.compartment})`);
      log("  Ask questions about this team's wiki. Type 'exit' to quit.\n");

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "  You > ",
      });

      rl.prompt();

      rl.on("line", async (line: string) => {
        const q = line.trim();
        if (!q) {
          rl.prompt();
          return;
        }
        if (q.toLowerCase() === "exit" || q.toLowerCase() === "quit") {
          log("  Goodbye.");
          rl.close();
          return;
        }

        log("  Thinking...\n");
        try {
          const result = await engine.query(q, opts.persist);
          log(`  Wiki > ${result.answer}\n`);
          if (result.pagesUpserted.length > 0) {
            log(`  [Filed: ${result.pagesUpserted.join(", ")}]\n`);
          }
        } catch (e) {
          log(`  Error: ${e instanceof Error ? e.message : String(e)}\n`);
        }

        rl.prompt();
      });

      rl.on("close", () => {
        process.exit(0);
      });
    }
  });

// ── lint ─────────────────────────────────────────────────────────────────────

program
  .command("lint")
  .description("Health-check and auto-repair the wiki")
  .action(async (_opts, cmd) => {
    const engine = engineFromOpts(cmd);
    logSection(`Wiki Health Check (${engine.compartment})`);
    log("  Running lint...\n");
    const result = await engine.lint();
    log(`  ${result.report}`);
    log(`\n  Pages updated: ${result.pagesUpserted.length}`);
    log(`  Pages removed: ${result.pagesDeleted.length}`);
    log("");
  });

// ── clean ────────────────────────────────────────────────────────────────────

program
  .command("clean")
  .description("Delete all wiki pages for this compartment (keeps raw sources)")
  .action(async (_opts, cmd) => {
    const engine = engineFromOpts(cmd);
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(
      `  This will delete all wiki pages for '${engine.compartment}'. Are you sure? (yes/no) `,
      async (answer: string) => {
        rl.close();
        if (answer.toLowerCase() === "yes") {
          await engine.clean();
          log("  Wiki cleared. Run 'ingest --all' to rebuild.");
        } else {
          log("  Cancelled.");
        }
      }
    );
  });

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

if (process.argv.length < 3) {
  logSection("LLM-Wiki Generator");
  log("  Compartmentalised wiki builder backed by Bedrock + S3.\n");
  program.help();
}
