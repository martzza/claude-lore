import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";

export async function runIndex(opts: { force?: boolean; service?: string }): Promise<void> {
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

  console.log(`\n⟳ Building structural index for ${repo}...`);
  console.log("  Discovering files...");

  const startMs = Date.now();

  let result: {
    repo:         string;
    commit_sha:   string;
    file_count:   number;
    symbol_count: number;
    edge_count:   number;
    skipped:      boolean;
    duration_ms:  number;
  };

  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/structural/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, cwd, force: opts.force ?? false }),
      signal: AbortSignal.timeout(60000), // indexing can take a while
    });

    if (!response.ok) {
      const err = await response.json() as { error?: string };
      console.error(`\n✗ Index failed: ${err.error ?? response.statusText}`);
      process.exit(1);
    }

    result = await response.json() as typeof result;
  } catch (err) {
    const isNetworkError = err instanceof TypeError || (err instanceof Error && err.message.includes("fetch"));
    if (isNetworkError) {
      console.error(`\n✗ Worker not running. Start it with: claude-lore worker start`);
    } else {
      console.error(`\n✗ Index failed: ${String(err)}`);
    }
    process.exit(1);
  }

  if (result.skipped) {
    console.log(`  Already up to date (commit ${result.commit_sha.slice(0, 7)})`);
    console.log(`  Use --force to rebuild anyway.\n`);
    return;
  }

  const duration = ((Date.now() - startMs) / 1000).toFixed(1);

  console.log(`  Extracting symbols...   ${result.symbol_count} symbols extracted`);
  console.log(`  Building call graph...  ${result.edge_count} edges extracted`);
  console.log(`\n✓ Index complete in ${duration}s`);
  console.log(`  Symbols: ${result.symbol_count} · Call edges: ${result.edge_count} · Commit: ${result.commit_sha.slice(0, 7)}`);
  console.log(`\n  ✓ structural.db written to .codegraph/structural.db`);
  console.log(`\n  Now available:`);
  console.log(`    /lore what breaks if I change <symbol>`);
  console.log(`    /lore who calls <symbol>`);
  console.log(`    claude-lore graph symbol <symbol> --open\n`);
}
