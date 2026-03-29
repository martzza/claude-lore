import { writeFileSync } from "fs";
import { resolve } from "path";
import { join } from "path";
import { tmpdir } from "os";
import { openInBrowser } from "../utils/browser.js";

const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function assertWorkerRunning(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error();
  } catch {
    console.error("Worker not running. Start it first:\n  claude-lore worker start");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// claude-lore annotate <file_path>
// ---------------------------------------------------------------------------

export async function runAnnotate(
  filePath: string,
  opts: { format?: string; repo?: string },
): Promise<void> {
  await assertWorkerRunning();

  const absPath = resolve(filePath);
  const repo = opts.repo ?? process.cwd();
  const format = opts.format ?? "html";

  const qs = new URLSearchParams({ path: absPath, repo, format }).toString();
  const url = `${BASE_URL}/api/annotation/file?${qs}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  } catch (err) {
    console.error(`Request failed: ${String(err)}`);
    process.exit(1);
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`Error: ${body}`);
    process.exit(1);
  }

  if (format === "html") {
    const html = await res.text();
    const tmpFile = join(tmpdir(), `claude-lore-annotate-${Date.now()}.html`);
    writeFileSync(tmpFile, html);
    openInBrowser(tmpFile);
    return;
  }

  // text or json
  const body = await res.text();
  if (format === "json") {
    process.stdout.write(body);
    process.stdout.write("\n");
    return;
  }

  // text: print a human-readable summary
  try {
    const data = JSON.parse(body) as {
      annotations?: Array<{ line: number; symbol: string; records: Array<{ type: string; title: string; confidence: string }> }>;
    };
    const annotations = data.annotations ?? [];
    if (annotations.length === 0) {
      console.log(`No reasoning annotations found for: ${absPath}`);
      return;
    }
    console.log(`\nAnnotations for: ${absPath}\n`);
    for (const anno of annotations) {
      console.log(`  Line ${anno.line} — ${anno.symbol}`);
      for (const rec of anno.records) {
        const icon = rec.type === "risk" ? "⚠" : rec.type === "decision" ? "●" : rec.type === "deferred" ? "◎" : "⌚";
        console.log(`    ${icon} [${rec.confidence}] ${rec.title}`);
      }
    }
  } catch {
    process.stdout.write(body);
  }
}

// ---------------------------------------------------------------------------
// claude-lore provenance <symbol>
// ---------------------------------------------------------------------------

export async function runProvenance(
  symbol: string,
  opts: { format?: string; repo?: string; open?: boolean },
): Promise<void> {
  await assertWorkerRunning();

  const repo = opts.repo ?? process.cwd();
  const format = opts.open ? "html" : (opts.format ?? "text");

  const qs = new URLSearchParams({ symbol, repo, format }).toString();
  const url = `${BASE_URL}/api/annotation/provenance?${qs}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  } catch (err) {
    console.error(`Request failed: ${String(err)}`);
    process.exit(1);
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`Error: ${body}`);
    process.exit(1);
  }

  const body = await res.text();

  if (format === "html") {
    const tmpFile = join(tmpdir(), `claude-lore-provenance-${Date.now()}.html`);
    writeFileSync(tmpFile, body);
    openInBrowser(tmpFile);
    return;
  }

  process.stdout.write(body);
  process.stdout.write("\n");
}

// ---------------------------------------------------------------------------
// claude-lore coverage
// ---------------------------------------------------------------------------

export async function runCoverage(opts: { repo?: string; cwd?: string }): Promise<void> {
  await assertWorkerRunning();

  const repo = opts.repo ?? process.cwd();
  const cwd = opts.cwd ?? repo;

  const qs = new URLSearchParams({ repo, cwd }).toString();
  const url = `${BASE_URL}/api/annotation/coverage?${qs}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  } catch (err) {
    console.error(`Request failed: ${String(err)}`);
    process.exit(1);
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`Error: ${body}`);
    process.exit(1);
  }

  const data = await res.json() as {
    coverage_pct: number;
    total_symbols: number;
    annotated_symbols: number;
    unannotated: string[];
    files_scanned: number;
  };

  console.log(`\nAnnotation coverage — ${repo}`);
  console.log(`  Files scanned:       ${data.files_scanned}`);
  console.log(`  Total symbols:       ${data.total_symbols}`);
  console.log(`  Annotated symbols:   ${data.annotated_symbols}`);
  console.log(`  Coverage:            ${data.coverage_pct}%`);

  if (data.unannotated.length > 0) {
    const show = data.unannotated.slice(0, 20);
    console.log(`\n  Unannotated symbols (first ${show.length}):`);
    for (const sym of show) {
      console.log(`    • ${sym}`);
    }
    if (data.unannotated.length > 20) {
      console.log(`    ... and ${data.unannotated.length - 20} more`);
    }
  }
}
