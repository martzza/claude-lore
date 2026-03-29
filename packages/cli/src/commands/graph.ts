import { writeFileSync } from "fs";
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

async function fetchGraph(endpoint: string, params: Record<string, string>): Promise<string> {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE_URL}/api/graph/${endpoint}?${qs}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph request failed: ${err}`);
  }
  return res.text();
}

async function handleOutput(
  content: string,
  format: string,
  open: boolean,
  label: string,
): Promise<void> {
  if (format === "html" || open) {
    const tmpFile = join(tmpdir(), `claude-lore-graph-${Date.now()}.html`);
    // If format is not html but open is requested, re-fetch as html
    const html = format === "html" ? content : content;
    writeFileSync(tmpFile, html);
    openInBrowser(tmpFile);
    return;
  }

  if (format === "json") {
    try {
      const parsed = JSON.parse(content) as { meta?: { node_count?: number; edge_count?: number } };
      const meta = parsed.meta ?? {};
      process.stdout.write(content);
      process.stderr.write(
        `\n# ${label}: ${meta.node_count ?? "?"} nodes, ${meta.edge_count ?? "?"} edges\n`,
      );
    } catch {
      process.stdout.write(content);
    }
    return;
  }

  // mermaid / dot: print to stdout
  process.stdout.write(content);
  process.stdout.write("\n");
}

export async function graphDecisions(opts: {
  format?: string;
  open?: boolean;
  repo?: string;
}): Promise<void> {
  await assertWorkerRunning();

  const repo = opts.repo ?? process.cwd();
  const format = opts.open ? "html" : (opts.format ?? "mermaid");

  try {
    const content = await fetchGraph("decisions", { repo, format });
    await handleOutput(content, format, opts.open ?? false, "Decision hierarchy");
  } catch (err) {
    console.error(`Error: ${String(err)}`);
    process.exit(1);
  }
}

export async function graphSymbol(
  symbol: string,
  opts: { format?: string; open?: boolean; repo?: string },
): Promise<void> {
  await assertWorkerRunning();

  const repo = opts.repo ?? process.cwd();
  const format = opts.open ? "html" : (opts.format ?? "mermaid");

  try {
    const content = await fetchGraph("symbol", { symbol, repo, format });
    await handleOutput(content, format, opts.open ?? false, `Symbol impact — ${symbol}`);
  } catch (err) {
    console.error(`Error: ${String(err)}`);
    process.exit(1);
  }
}

export async function graphPortfolio(opts: {
  format?: string;
  open?: boolean;
  repos?: string;
}): Promise<void> {
  await assertWorkerRunning();

  const format = opts.open ? "html" : (opts.format ?? "mermaid");
  const params: Record<string, string> = { format };
  if (opts.repos) params["repos"] = opts.repos;

  try {
    const content = await fetchGraph("portfolio", params);
    await handleOutput(content, format, opts.open ?? false, "Portfolio graph");
  } catch (err) {
    console.error(`Error: ${String(err)}`);
    process.exit(1);
  }
}
