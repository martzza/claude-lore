// Types mirrored from worker — received via HTTP, not imported directly
interface DiscoveredFile {
  path: string;
  relativePath: string;
  classes: string[];
  size: number;
}

interface ImportedRecord {
  type: "decision" | "deferred" | "risk";
  content: string;
  rationale?: string;
  source: string;
  fingerprint: string;
}

interface ImportRunResult {
  discovered: DiscoveredFile[];
  records: ImportedRecord[];
  written: number;
  skipped: number;
  dry_run: boolean;
}

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

async function fetchImport(opts: {
  repo: string;
  path?: string;
  file?: string;
  dryRun: boolean;
}): Promise<ImportRunResult> {
  const res = await fetch(`${BASE_URL}/api/bootstrap/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("Import failed:", err);
    process.exit(1);
  }
  const data = (await res.json()) as { result: ImportRunResult };
  return data.result;
}

function printDiscovery(discovered: DiscoveredFile[], repo: string): void {
  const count = discovered.length;
  console.log(`\nFound ${count} markdown file${count !== 1 ? "s" : ""}:`);

  // Group generics to collapse them
  const named = discovered.filter((f) => {
    const primary = f.classes[0];
    return primary !== "generic";
  });
  const generic = discovered.filter((f) => {
    const primary = f.classes[0];
    return primary === "generic";
  });

  const labelWidth = 14;

  for (const f of named) {
    const label = `[${f.classes.join("/")}]`.padEnd(labelWidth);
    console.log(`  ${label} ${f.relativePath}`);
  }

  if (generic.length > 0) {
    const label = "[generic]".padEnd(labelWidth);
    const first3 = generic
      .slice(0, 3)
      .map((f) => f.relativePath)
      .join(", ");
    const rest = generic.length > 3 ? ` ... (${generic.length - 3} more)` : "";
    console.log(`  ${label} ${first3}${rest}`);
  }
}

function printExtracted(result: ImportRunResult): void {
  const decisions = result.records.filter((r) => r.type === "decision").length;
  const risks = result.records.filter((r) => r.type === "risk").length;
  const deferred = result.records.filter((r) => r.type === "deferred").length;
  const total = result.records.length;

  console.log("\nExtracted:");
  if (decisions > 0) console.log(`  ${decisions} decision record${decisions !== 1 ? "s" : ""}`);
  if (risks > 0) console.log(`  ${risks} risk record${risks !== 1 ? "s" : ""}`);
  if (deferred > 0) console.log(`  ${deferred} deferred record${deferred !== 1 ? "s" : ""}`);

  if (total === 0) {
    console.log("  (none — no strong signals found)");
    return;
  }

  const dupNote = result.skipped > 0 ? ` — ${result.skipped} duplicate${result.skipped !== 1 ? "s" : ""} skipped` : "";
  console.log(`  ${total} total${dupNote}`);
}

function printDryRunRecords(records: ImportedRecord[]): void {
  for (const r of records) {
    const label = `[${r.type} · inferred]`;
    console.log(`\n  ${label} ${r.content.slice(0, 70)}`);
    console.log(`    Source: ${r.source}`);
    if (r.rationale) {
      const preview = r.rationale.replace(/\n/g, " ").slice(0, 100);
      console.log(`    ${preview}`);
    }
  }
}

export async function runImportCommand(opts: {
  dryRun?: boolean;
  path?: string;
  file?: string;
}): Promise<void> {
  const repo = process.cwd();

  await assertWorkerRunning();

  process.stdout.write(`\n⟳ Scanning ${repo} for documentation...\n`);

  const result = await fetchImport({
    repo,
    path: opts.path,
    file: opts.file,
    dryRun: opts.dryRun ?? false,
  });

  if (result.discovered.length === 0) {
    console.log("  No markdown files found.");
    return;
  }

  printDiscovery(result.discovered, repo);
  printExtracted(result);

  if (result.records.length === 0) return;

  if (opts.dryRun) {
    printDryRunRecords(result.records);
    console.log("\nDry run complete — nothing written.");
    return;
  }

  console.log(`\n${result.written} record${result.written !== 1 ? "s" : ""} written with confidence: inferred`);
  console.log("Run: claude-lore review   to confirm or discard");
}
