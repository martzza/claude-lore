import { createInterface } from "readline";

const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";
const BASE_URL = `http://127.0.0.1:${PORT}`;

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

async function promptEnter(message: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

async function checkFirstRun(repo: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${BASE_URL}/api/sessions/first-run?repo=${encodeURIComponent(repo)}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return false;
    const data = (await res.json()) as { first_run: boolean };
    return data.first_run ?? false;
  } catch {
    return false;
  }
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

interface ImportResult {
  written: number;
  skipped: number;
  records: Array<{ type: string; content: string }>;
  discovered: unknown[];
  dry_run: boolean;
}

interface ClaudeMdFinding {
  type: "redundant" | "missing" | "outdated" | "optimise";
  description: string;
  line?: number;
  suggestion?: string;
}

interface ClaudeMdAnalysis {
  claude_md_present: boolean;
  token_estimate: number;
  findings: ClaudeMdFinding[];
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

function getFileName(discovered: unknown): string {
  if (typeof discovered === "string") {
    return discovered.split("/").pop() ?? discovered;
  }
  if (typeof discovered === "object" && discovered !== null) {
    const obj = discovered as Record<string, unknown>;
    const p = obj["path"] ?? obj["file"] ?? obj["name"];
    if (typeof p === "string") return p.split("/").pop() ?? p;
  }
  return String(discovered);
}

function fileDescription(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower === "claude.md") return "extracting decisions and conventions";
  if (lower === "readme.md") return "light scan for project context";
  if (/adr[s\-_/]/i.test(lower) || lower.includes("decision")) return "extracting architectural decision";
  if (lower.includes("contributing")) return "extracting conventions and guidelines";
  if (lower.includes("changelog")) return "extracting version history signals";
  if (lower.endsWith(".md")) return "scanning for decisions and constraints";
  return "scanning";
}

async function runImporterVerbose(repo: string, dryRun: boolean): Promise<ImportResult | null> {
  console.log("STEP 1 — Scanning existing documentation");
  console.log("─────────────────────────────────────────");
  console.log("claude-lore is reading your .md files, ADRs, and git history");
  console.log("to extract decisions and constraints already documented in");
  console.log("this codebase.\n");
  process.stdout.write(`⟳ Scanning ${repo}...\n\n`);

  try {
    const res = await fetch(`${BASE_URL}/api/bootstrap/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, dryRun }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { result: ImportResult };
    const { written, skipped, records, discovered } = data.result;

    if (discovered.length === 0) {
      console.log("  No documentation files found to scan.\n");
      return data.result;
    }

    for (const file of discovered) {
      const filename = getFileName(file);
      console.log(`  Found: ${filename.padEnd(24)} → ${fileDescription(filename)}`);
    }

    // Check for git commit signals in records
    const gitRecords = records.filter((r) =>
      r.content.toLowerCase().includes("commit") || r.content.toLowerCase().includes("git"),
    );
    if (gitRecords.length > 0) {
      console.log(`  Found: git history           → ${gitRecords.length} commit(s) with decision signals`);
    }

    console.log();
    if (dryRun) {
      console.log(`  Would extract ${records.length} record${records.length !== 1 ? "s" : ""} (dry run — nothing written)\n`);
    } else {
      const dupNote = skipped > 0 ? ` (${skipped} duplicate${skipped !== 1 ? "s" : ""} skipped)` : "";
      console.log(`  Extracted ${written} record${written !== 1 ? "s" : ""}${dupNote} (confidence: inferred)`);
      console.log("  These will appear in your agent's context immediately.\n");
    }

    // Summary box
    if (!dryRun && records.length > 0) {
      const counts: Record<string, number> = {};
      for (const r of records) {
        counts[r.type] = (counts[r.type] ?? 0) + 1;
      }
      const decisions = counts["decision"] ?? 0;
      const risks = counts["risk"] ?? 0;
      const deferred = counts["deferred_work"] ?? counts["deferred"] ?? 0;

      console.log("  What was found:");
      console.log("  ┌──────────────────────────────────────────────────────┐");
      if (decisions > 0) console.log(`  │  ${String(decisions).padStart(2)} architectural decision${decisions !== 1 ? "s" : ""}                           │`);
      if (risks > 0)     console.log(`  │  ${String(risks).padStart(2)} risk${risks !== 1 ? "s" : ""} to be aware of                              │`);
      if (deferred > 0)  console.log(`  │  ${String(deferred).padStart(2)} deferred item${deferred !== 1 ? "s" : ""} still in progress                  │`);
      if (decisions === 0 && risks === 0 && deferred === 0) {
        console.log(`  │  ${records.length} general record${records.length !== 1 ? "s" : ""} extracted                          │`);
      }
      console.log("  └──────────────────────────────────────────────────────┘");
      console.log("\n  Your agent now knows about these. To review them:");
      console.log("    claude-lore review\n");
    }

    return data.result;
  } catch {
    console.log("  Scan skipped (importer unavailable).\n");
    return null;
  }
}

async function runImporterSilent(repo: string, dryRun: boolean): Promise<ImportResult | null> {
  process.stdout.write("⟳ Scanning for existing documentation...\n");
  try {
    const res = await fetch(`${BASE_URL}/api/bootstrap/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, dryRun }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result: ImportResult };
    const { written, skipped, records, discovered } = data.result;
    if (discovered.length === 0 || records.length === 0) return data.result;
    if (dryRun) {
      console.log(`  Would import ${records.length} record${records.length !== 1 ? "s" : ""} from ${discovered.length} file${discovered.length !== 1 ? "s" : ""} (dry run)`);
    } else {
      const dupNote = skipped > 0 ? `, ${skipped} duplicate${skipped !== 1 ? "s" : ""} skipped` : "";
      console.log(`✓ Imported ${written} record${written !== 1 ? "s" : ""} from ${discovered.length} file${discovered.length !== 1 ? "s" : ""}${dupNote} (run claude-lore review to confirm)`);
    }
    return data.result;
  } catch {
    return null;
  }
}

async function showClaudeMdSuggestions(repo: string, cwd: string, dryRun: boolean): Promise<void> {
  try {
    const res = await fetch(
      `${BASE_URL}/api/advisor/claudemd?repo=${encodeURIComponent(repo)}&cwd=${encodeURIComponent(cwd)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return;

    const analysis = (await res.json()) as ClaudeMdAnalysis;
    if (!analysis.claude_md_present || analysis.findings.length === 0) return;

    const redundant = analysis.findings.filter((f) => f.type === "redundant");
    const missing = analysis.findings.filter((f) => f.type === "missing");
    const outdated = analysis.findings.filter((f) => f.type === "outdated");
    const optimise = analysis.findings.filter((f) => f.type === "optimise");

    if (redundant.length === 0 && missing.length === 0 && outdated.length === 0 && optimise.length === 0) return;

    console.log("CLAUDE.md suggestions");
    console.log("─────────────────────");
    console.log("claude-lore found some ways to improve your CLAUDE.md based");
    console.log("on what's now in the knowledge graph.\n");

    if (optimise.length > 0) {
      console.log("  TOKEN BUDGET");
      for (const f of optimise) {
        console.log(`  • ${f.description}`);
        if (f.suggestion) console.log(`    ${f.suggestion}`);
        console.log();
      }
    }

    if (redundant.length > 0) {
      console.log("  SECTIONS THAT CAN BE SIMPLIFIED");
      console.log("  These sections may duplicate confirmed graph records.");
      console.log("  Your agent reads the graph directly — these add token");
      console.log("  cost without adding information.\n");
      for (const f of redundant) {
        console.log(`  • ${f.description.slice(0, 100)}`);
        if (f.suggestion) console.log(`    ${f.suggestion}`);
        console.log();
      }
    }

    if (missing.length > 0) {
      console.log("  SECTIONS WORTH ADDING");
      console.log("  These items aren't in CLAUDE.md yet.\n");
      for (const f of missing) {
        console.log(`  • ${f.description.slice(0, 100)}`);
        if (f.suggestion) console.log(`    ${f.suggestion}`);
        console.log();
      }
    }

    if (outdated.length > 0) {
      console.log("  POTENTIALLY OUTDATED");
      for (const f of outdated) {
        console.log(`  • ${f.description.slice(0, 100)}`);
        if (f.suggestion) console.log(`    ${f.suggestion}`);
        console.log();
      }
    }

    if (dryRun) {
      console.log("  (dry run — skipping apply prompt)\n");
      return;
    }

    console.log("  Apply these suggestions now?");
    console.log("  [y] Apply all suggestions");
    console.log("  [s] Show me each one individually");
    console.log("  [n] Skip for now (run: claude-lore advisor claudemd later)\n");

    const answer = await prompt("> ");

    if (answer === "y") {
      await fetch(`${BASE_URL}/api/advisor/claudemd/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, cwd, mode: "all" }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
      console.log("  ✓ CLAUDE.md updated\n");
    } else if (answer === "s") {
      await fetch(`${BASE_URL}/api/advisor/claudemd/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, cwd, mode: "interactive" }),
        signal: AbortSignal.timeout(30000),
      }).catch(() => {});
    } else {
      console.log("  Skipped. Run: claude-lore advisor claudemd --apply\n");
    }
  } catch {
    // CLAUDE.md analysis is optional — never block bootstrap
  }
}

function showWelcomeBanner(): Promise<void> {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Welcome to claude-lore");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  console.log("  claude-lore gives your AI coding agent a persistent memory");
  console.log("  of this codebase — decisions made, risks identified, work");
  console.log("  deferred, and what was in progress last session.\n");
  console.log("  HOW IT WORKS\n");
  console.log("  Every time you work in Claude Code or Cursor, claude-lore");
  console.log("  automatically captures what happened. At the start of each");
  console.log("  new session, that context is injected back — so your agent");
  console.log("  never starts cold.\n");
  console.log("  WHAT BOOTSTRAP DOES\n");
  console.log("  Bootstrap pre-populates that memory right now, before you've");
  console.log("  had any sessions. It does two things:\n");
  console.log("  1. Scans your existing documentation (.md files, ADRs, git");
  console.log("     history) and extracts decisions, risks, and deferred items.\n");
  console.log("  2. Optionally applies security and compliance templates (like");
  console.log("     OWASP Top 10) that create baseline risk records.\n");
  console.log("  All records start as [inferred] — your agent will treat them");
  console.log("  as guidance, not ground truth. You confirm the important ones");
  console.log("  over time using: claude-lore review\n");
  console.log("  WHAT HAPPENS NEXT\n");
  console.log("  After bootstrap, open this repo in Claude Code. Your agent");
  console.log("  will automatically receive the captured context at session");
  console.log("  start. You don't need to do anything — it just works.\n");
  console.log("  To see what was captured:   claude-lore review");
  console.log("  To query the graph:         /lore what did we decide about X");
  console.log("  To see the decision graph:  claude-lore graph decisions --open\n");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  return promptEnter("  Press Enter to continue, or Ctrl+C to exit\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n> ");
}

function showBootstrapSummary(
  importResult: ImportResult | null,
  templateResults: RunResult[],
  isFirstRun: boolean,
): void {
  let totalDecisions = 0;
  let totalRisks = 0;
  let totalDeferred = 0;
  let totalWritten = 0;

  if (importResult) {
    for (const r of importResult.records) {
      if (r.type === "decision") totalDecisions++;
      else if (r.type === "risk") totalRisks++;
      else if (r.type === "deferred_work" || r.type === "deferred") totalDeferred++;
    }
    totalWritten += importResult.written;
  }

  for (const result of templateResults) {
    for (const r of result.records) {
      if (r.type === "decision") totalDecisions++;
      else if (r.type === "risk") totalRisks++;
      else if (r.type === "deferred_work" || r.type === "deferred") totalDeferred++;
    }
    totalWritten += result.written;
  }

  const typeSummary = [
    totalDecisions > 0 ? `${totalDecisions} decision${totalDecisions !== 1 ? "s" : ""}` : "",
    totalRisks > 0 ? `${totalRisks} risk${totalRisks !== 1 ? "s" : ""}` : "",
    totalDeferred > 0 ? `${totalDeferred} deferred item${totalDeferred !== 1 ? "s" : ""}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Bootstrap complete");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  console.log(`  Records added: ${totalWritten}`);
  if (typeSummary) console.log(`    ${typeSummary}`);
  console.log("  All confidence: inferred (not yet confirmed)\n");

  if (isFirstRun) {
    console.log("  WHAT TO DO NOW\n");
    console.log("  1. Open this repo in Claude Code");
    console.log("     Your agent will receive this context automatically.");
    console.log('     Look for the "claude-lore context" section at session start.\n');
    console.log("  2. Work normally");
    console.log("     claude-lore captures decisions and risks as you work.");
    console.log("     No manual steps required.\n");
    console.log("  3. Review captured records periodically");
    console.log("     claude-lore review");
    console.log("     Confirm the important ones, discard the irrelevant ones.");
    console.log("     Confirmed records carry more weight with your agent.\n");
    console.log("  USEFUL COMMANDS\n");
    console.log("  claude-lore review              See pending records");
    console.log("  claude-lore advisor             Workflow and gap suggestions");
    console.log("  claude-lore graph decisions     Visualise decision relationships");
    console.log("  /lore <question>                Ask about this codebase in Claude Code\n");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
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

  if (opts.list) {
    const templates = await fetchTemplates(repo, true);
    console.log("Available templates:");
    for (const t of templates) {
      const tag = t.hidden ? " [hidden — use --framework to run]" : "";
      console.log(`  ${t.id.padEnd(16)} — ${t.description}${tag}`);
    }
    return;
  }

  const isFirstRun = await checkFirstRun(repo);

  // First run: show welcome banner and verbose import
  if (isFirstRun && !opts.dryRun) {
    await showWelcomeBanner();
    console.log();
  }

  // Run importer
  let importResult: ImportResult | null;
  if (isFirstRun && !opts.dryRun) {
    importResult = await runImporterVerbose(repo, false);
  } else {
    importResult = await runImporterSilent(repo, opts.dryRun ?? false);
    console.log();
  }

  // CLAUDE.md suggestions after import (first run only, non-dry-run)
  if (isFirstRun && !opts.dryRun) {
    await showClaudeMdSuggestions(repo, repo, false);
  }

  // Determine which templates to run
  let templateIds: string[];

  if (opts.framework) {
    templateIds = [opts.framework];
  } else {
    const available = await fetchTemplates(repo);

    if (available.length === 0) {
      console.log("No templates available.");
      if (isFirstRun) showBootstrapSummary(importResult, [], true);
      return;
    }

    if (opts.all || opts.dryRun) {
      templateIds = available.map((t) => t.id);
    } else {
      if (isFirstRun) {
        console.log("STEP 2 — Security and compliance templates");
        console.log("──────────────────────────────────────────");
        console.log("Optionally add baseline risk records from security templates.");
        console.log("These give your agent awareness of common vulnerabilities\n");
        console.log("and compliance requirements relevant to your stack.\n");
      } else {
        console.log("Available templates:\n");
      }

      available.forEach((t, i) => {
        console.log(`  [${i + 1}] ${t.name} — ${t.description}`);
      });
      console.log(`\n  (Add your own in ~/.codegraph/templates/)\n`);

      const answer = await prompt(
        "Select templates to run (comma-separated numbers, or 'all', or 'none'):\n> ",
      );

      if (answer === "" || answer === "none") {
        if (isFirstRun) {
          showBootstrapSummary(importResult, [], true);
        } else {
          console.log("No templates selected.");
        }
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

  // Dry-run preview
  const preview = await fetchRun(repo, templateIds, true);
  printPreview(preview);

  if (opts.dryRun) {
    console.log("\nDry run complete — nothing written.");
    return;
  }

  // Confirm (skip with --yes)
  let write = opts.yes ?? false;
  if (!write) {
    const answer = await prompt("\nWrite these records? (y/N): ");
    write = answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
  }

  if (!write) {
    console.log("Aborted — nothing written.");
    return;
  }

  // Write
  const results = await fetchRun(repo, templateIds, false);
  let totalWritten = 0;

  if (isFirstRun) {
    console.log("\nSTEP 2 — Security templates");
    console.log("────────────────────────────");
  }

  for (const result of results) {
    totalWritten += result.written;
    if (isFirstRun) {
      const risks = result.records.filter((r) => r.type === "risk").length;
      console.log(`\nThe ${result.template} template added ${result.written} record${result.written !== 1 ? "s" : ""}${risks > 0 ? ` (${risks} risk${risks !== 1 ? "s" : ""})` : ""}.`);
      console.log("Your agent will surface these when working on relevant code.\n");
      console.log("These are starting points — review and discard any that don't");
      console.log("apply to this codebase:");
      console.log("  claude-lore review\n");
    } else {
      console.log(`  [${result.template}] ${result.written} record(s) written`);
    }
  }

  if (!isFirstRun) {
    console.log(`\n${totalWritten} record(s) written with confidence: inferred`);
  }

  showBootstrapSummary(importResult, results, isFirstRun);
}
