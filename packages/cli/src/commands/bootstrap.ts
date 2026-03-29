import { createInterface } from "readline";

const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function runImporterPrelude(repo: string, dryRun: boolean): Promise<void> {
  process.stdout.write("⟳ Scanning for existing documentation...\n");
  try {
    const res = await fetch(`${BASE_URL}/api/bootstrap/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, dryRun }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return; // silent — bootstrap still continues

    const data = (await res.json()) as {
      result: { written: number; skipped: number; records: unknown[]; discovered: unknown[]; dry_run: boolean };
    };
    const { written, skipped, records, discovered } = data.result;

    if (discovered.length === 0 || records.length === 0) return; // skip silently

    if (dryRun) {
      console.log(
        `  Would import ${records.length} record${records.length !== 1 ? "s" : ""} from ${discovered.length} file${discovered.length !== 1 ? "s" : ""} (dry run)`,
      );
    } else {
      const dupNote = skipped > 0 ? `, ${skipped} duplicate${skipped !== 1 ? "s" : ""} skipped` : "";
      console.log(
        `✓ Imported ${written} record${written !== 1 ? "s" : ""} from ${discovered.length} file${discovered.length !== 1 ? "s" : ""}${dupNote} (run claude-lore review to confirm)`,
      );
    }
  } catch {
    // Importer failure never blocks bootstrap
  }
}

async function assertWorkerRunning(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error();
  } catch {
    console.error("Worker not running. Start it first:\n  claude-lore worker start");
    process.exit(1);
  }
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

interface TemplateMeta {
  id: string;
  name: string;
  description: string;
  version: string;
  hidden?: boolean;
}

interface RunResult {
  template: string;
  records: Array<{ type: string; content: string }>;
  written: number;
  dry_run: boolean;
}

async function fetchTemplates(repo: string, includeHidden = false): Promise<TemplateMeta[]> {
  const url = `${BASE_URL}/api/bootstrap/templates?repo=${encodeURIComponent(repo)}${includeHidden ? "&includeHidden=true" : ""}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error("Failed to list templates");
    process.exit(1);
  }
  const data = (await res.json()) as { templates: TemplateMeta[] };
  return data.templates;
}

async function fetchRun(repo: string, templateIds: string[], dryRun: boolean): Promise<RunResult[]> {
  const res = await fetch(`${BASE_URL}/api/bootstrap/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, templateIds, dryRun }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("Bootstrap failed:", err);
    process.exit(1);
  }
  const data = (await res.json()) as { results: RunResult[] };
  return data.results;
}

function printPreview(results: RunResult[]): void {
  for (const result of results) {
    const total = result.records.length;
    console.log(`\nPreview — ${result.template} will write ${total} record${total !== 1 ? "s" : ""}:`);
    const shown = result.records.slice(0, 5);
    for (const r of shown) {
      console.log(`  [${r.type}] ${r.content.slice(0, 80)}`);
    }
    if (total > 5) {
      console.log(`  ... (${total - 5} more)`);
    }
  }
}

export async function runBootstrap(opts: {
  framework?: string;
  dryRun?: boolean;
  list?: boolean;
  all?: boolean;
  yes?: boolean;
}): Promise<void> {
  const repo = process.cwd();

  await assertWorkerRunning();

  // Run importer before template selection (silent on no results)
  if (!opts.list) {
    await runImporterPrelude(repo, opts.dryRun ?? false);
    console.log();
  }

  if (opts.list) {
    const templates = await fetchTemplates(repo, true);
    console.log("Available templates:");
    for (const t of templates) {
      const tag = t.hidden ? " [hidden — use --framework to run]" : "";
      console.log(`  ${t.id.padEnd(16)} — ${t.description}${tag}`);
    }
    return;
  }

  // Step 1: determine which templates to run
  let templateIds: string[];

  if (opts.framework) {
    // Direct: single template, no selection prompt
    templateIds = [opts.framework];
  } else {
    const available = await fetchTemplates(repo);

    if (available.length === 0) {
      console.log("No templates available.");
      return;
    }

    if (opts.all || opts.dryRun) {
      // --all or --dry-run: use all non-hidden templates, no selection prompt
      templateIds = available.map((t) => t.id);
    } else {
      // Interactive selection
      console.log("Available templates:\n");
      available.forEach((t, i) => {
        console.log(`  [${i + 1}] ${t.name} — ${t.description}`);
      });
      console.log(`\n  (Add your own in ~/.codegraph/templates/)\n`);

      const answer = await prompt(
        "Select templates to run (comma-separated numbers, or 'all', or 'none'):\n> ",
      );

      if (answer === "" || answer === "none") {
        console.log("No templates selected. Exiting.");
        return;
      }

      if (answer === "all") {
        templateIds = available.map((t) => t.id);
      } else {
        const indices = answer
          .split(",")
          .map((s) => parseInt(s.trim(), 10) - 1)
          .filter((i) => i >= 0 && i < available.length);
        if (indices.length === 0) {
          console.log("No valid selection. Exiting.");
          return;
        }
        templateIds = indices.map((i) => available[i]!.id);
      }
    }
  }

  // Step 2: dry-run preview
  const preview = await fetchRun(repo, templateIds, true);
  printPreview(preview);

  if (opts.dryRun) {
    console.log("\nDry run complete — nothing written.");
    return;
  }

  // Step 3: confirm (skip with --yes)
  let write = opts.yes ?? false;
  if (!write) {
    const answer = await prompt("\nWrite these records? (y/N): ");
    write = answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
  }

  if (!write) {
    console.log("Aborted — nothing written.");
    return;
  }

  // Step 4: write
  const results = await fetchRun(repo, templateIds, false);
  let totalWritten = 0;
  for (const result of results) {
    totalWritten += result.written;
    console.log(`  [${result.template}] ${result.written} record(s) written`);
  }
  console.log(`\n${totalWritten} record(s) written with confidence: inferred`);
}
