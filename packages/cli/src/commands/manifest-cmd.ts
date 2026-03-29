const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";
const BASE = `http://127.0.0.1:${PORT}`;

async function assertWorker(): Promise<void> {
  try {
    await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
  } catch {
    console.error("Worker not running. Start it with: claude-lore worker start");
    process.exit(1);
  }
}

export async function runManifestInfer(opts: { apply?: boolean }): Promise<void> {
  await assertWorker();
  const repo = process.cwd();
  const cwd = process.cwd();

  const res = await fetch(
    `${BASE}/api/manifest/infer?repo=${encodeURIComponent(repo)}&cwd=${encodeURIComponent(cwd)}`,
  );
  const data = (await res.json()) as {
    inferences: Array<{
      symbol: string;
      current_tier: string;
      suggested_tier: string;
      reason: string;
      is_override: boolean;
    }>;
    overrides: number;
  };

  if (data.inferences.length === 0) {
    console.log("No symbols with reasoning records found for this repo.");
    return;
  }

  const overrides = data.inferences.filter((i) => i.is_override);
  const matching = data.inferences.filter((i) => !i.is_override);

  if (matching.length > 0) {
    console.log(`\n✓ ${matching.length} symbol(s) already at suggested tier`);
  }

  if (overrides.length === 0) {
    console.log("No tier changes suggested.");
    return;
  }

  console.log(`\nSuggested tier changes (${overrides.length}):\n`);
  console.log("  Symbol".padEnd(30) + "Current".padEnd(12) + "Suggested".padEnd(12) + "Reason");
  console.log("  " + "-".repeat(80));
  for (const inf of overrides) {
    console.log(
      `  ${inf.symbol.padEnd(28)} ${inf.current_tier.padEnd(12)} ${inf.suggested_tier.padEnd(12)} ${inf.reason.slice(0, 50)}`,
    );
  }
  console.log(
    "\nTo apply, update exported_tier in the DB using: POST /api/records/confirm with the record id.",
  );
}
