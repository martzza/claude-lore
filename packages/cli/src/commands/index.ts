import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";

interface IndexResult {
  repo:            string;
  commit_sha:      string;
  file_count:      number;
  symbol_count:    number;
  edge_count:      number;
  skipped:         boolean;
  duration_ms:     number;
  incremental?:    boolean;
  changed_files?:  number;
  unchanged_files?: number;
}

export async function runIndex(opts: { force?: boolean; service?: string; watch?: boolean; incremental?: boolean }): Promise<void> {
  const cwd = resolve(process.cwd());

  if (!existsSync(cwd)) {
    console.error("Error: current directory does not exist");
    process.exit(1);
  }

  // Detect repo name from package.json or directory name
  let repo = cwd.split("/").pop() ?? cwd;
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8")) as Record<string, unknown>;
    if (typeof pkg["name"] === "string" && pkg["name"]) repo = pkg["name"];
  } catch { /* ok */ }

  if (opts.watch) {
    await runWatchMode(repo, cwd, opts.force ?? false);
    return;
  }

  await runOneshot(repo, cwd, opts.force ?? false);
}

async function runOneshot(repo: string, cwd: string, force: boolean): Promise<void> {
  console.log(`\n⟳ Building structural index for ${repo}...`);
  console.log("  Discovering files...");

  const startMs = Date.now();
  const result = await callIndex(repo, cwd, force);

  if (result.skipped) {
    console.log(`  Already up to date (commit ${result.commit_sha.slice(0, 7)})`);
    console.log(`  Use --force to rebuild anyway.\n`);
    return;
  }

  const duration = ((Date.now() - startMs) / 1000).toFixed(1);

  if (result.incremental && result.changed_files !== undefined) {
    console.log(`  Incremental update:     ${result.changed_files} files changed, ${result.unchanged_files ?? 0} unchanged`);
  }

  console.log(`  Extracting symbols...   ${result.symbol_count} symbols extracted`);
  console.log(`  Building call graph...  ${result.edge_count} edges extracted`);
  console.log(`\n✓ Index ${result.incremental ? "updated" : "complete"} in ${duration}s`);

  if (result.incremental) {
    console.log(`  Changed: ${result.changed_files} files (${result.unchanged_files ?? 0} skipped)`);
  }

  console.log(`  Symbols: ${result.symbol_count} · Call edges: ${result.edge_count} · Commit: ${result.commit_sha.slice(0, 7)}`);
  console.log(`\n  ✓ structural.db written to .codegraph/structural.db`);
  console.log(`\n  Now available:`);
  console.log(`    /lore what breaks if I change <symbol>`);
  console.log(`    /lore who calls <symbol>`);
  console.log(`    claude-lore graph symbol <symbol> --open\n`);
}

async function runWatchMode(repo: string, cwd: string, force: boolean): Promise<void> {
  // Initial index
  console.log(`\n⟳ Building structural index for ${repo}...`);
  const initial = await callIndex(repo, cwd, force);

  if (!initial.skipped) {
    console.log(`✓ Initial index complete — ${initial.symbol_count} symbols, ${initial.edge_count} edges`);
  } else {
    console.log(`✓ Index already up to date — ${initial.symbol_count} symbols, ${initial.edge_count} edges`);
  }

  // Start watch mode on the worker
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/structural/watch/start`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ repo, cwd }),
      signal:  AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const err = await res.json() as { error?: string };
      console.error(`\n✗ Failed to start watch mode: ${err.error ?? res.statusText}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`\n✗ Worker not running. Start it with: claude-lore worker start`);
    process.exit(1);
  }

  console.log(`✓ Watching ${cwd}`);
  console.log(`  Git hook installed at .git/hooks/post-commit`);
  console.log(`  Index updates automatically on file save and git commit\n`);
  console.log(`  Press Ctrl+C to stop watching\n`);

  // Keep process alive — watch output comes from the worker logs
  await new Promise<void>((resolve) => {
    process.on("SIGINT", async () => {
      console.log("\n\nStopping watch mode...");
      try {
        await fetch(`http://127.0.0.1:${PORT}/api/structural/watch/stop`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ repo }),
          signal:  AbortSignal.timeout(5000),
        });
      } catch {}
      resolve();
    });
  });
}

async function callIndex(repo: string, cwd: string, force: boolean): Promise<IndexResult> {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/structural/index`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ repo, cwd, force }),
      signal:  AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      const err = await response.json() as { error?: string };
      console.error(`\n✗ Index failed: ${err.error ?? response.statusText}`);
      process.exit(1);
    }

    return await response.json() as IndexResult;
  } catch (err) {
    const isNetworkError = err instanceof TypeError || (err instanceof Error && err.message.includes("fetch"));
    if (isNetworkError) {
      console.error(`\n✗ Worker not running. Start it with: claude-lore worker start`);
    } else {
      console.error(`\n✗ Index failed: ${String(err)}`);
    }
    process.exit(1);
  }
}
