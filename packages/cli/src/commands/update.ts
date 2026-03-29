import { execSync, spawnSync } from "child_process";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";
const BASE_URL = `http://127.0.0.1:${PORT}`;

function findClaudeLoreRoot(): string {
  // Walk up from cwd looking for the monorepo root
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "packages", "cli")) && existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: check known locations
  const candidates = [
    join(homedir(), "Documents", "claude-lore"),
    join(homedir(), "projects", "claude-lore"),
    join(homedir(), "code", "claude-lore"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "packages", "cli"))) return c;
  }
  return process.cwd();
}

async function pollHealth(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function runUpdate(): Promise<void> {
  console.log("Updating claude-lore...");

  const root = findClaudeLoreRoot();
  if (!existsSync(join(root, "packages", "cli", "src", "index.ts"))) {
    console.error(`Could not locate claude-lore source at ${root}`);
    console.error("Run this command from within the claude-lore repo.");
    process.exit(1);
  }

  // Step 1: Rebuild CLI
  process.stdout.write("⟳ Rebuilding CLI binary...\n");
  const outfile = join(root, "dist", "claude-lore");
  const buildResult = spawnSync(
    "bun",
    ["build", "packages/cli/src/index.ts", "--compile", `--outfile`, outfile],
    { cwd: root, stdio: "pipe" },
  );
  if (buildResult.status !== 0) {
    const stderr = buildResult.stderr?.toString() ?? "";
    console.error(`✗ Build failed:\n${stderr}`);
    process.exit(1);
  }
  console.log(`✓ Built dist/claude-lore`);

  // Step 2: Relink
  const binLink = join(homedir(), ".bun", "bin", "claude-lore");
  try {
    execSync(`ln -sf ${outfile} ${binLink}`);
    console.log(`✓ Linked to ${binLink}`);
  } catch (err) {
    console.log(`⚠ Could not relink ${binLink}: ${err}`);
  }

  // Step 3: Restart worker
  process.stdout.write("⟳ Restarting worker...\n");

  // Try PM2 first
  let restartedViaPm2 = false;
  const pm2Check = spawnSync("pm2", ["describe", "claude-lore-worker"], { stdio: "pipe" });
  if (pm2Check.status === 0) {
    const pm2Restart = spawnSync("pm2", ["restart", "claude-lore-worker"], { stdio: "pipe" });
    restartedViaPm2 = pm2Restart.status === 0;
  }

  if (!restartedViaPm2) {
    // Try stopping then starting via CLI worker commands
    try {
      // Stop: find and kill existing worker
      const pidFile = join(homedir(), ".codegraph", "worker.pid");
      if (existsSync(pidFile)) {
        const { readFileSync } = await import("fs");
        const pid = readFileSync(pidFile, "utf8").trim();
        try { execSync(`kill ${pid}`); } catch {}
      }
      // Start fresh
      spawnSync("claude-lore", ["worker", "start"], { stdio: "pipe" });
    } catch {}
  }

  // Step 4: Poll health
  const healthy = await pollHealth(5000);
  if (healthy) {
    console.log(`✓ Worker healthy on ${BASE_URL}`);
  } else {
    console.log(`⚠ Worker did not respond within 5s — check: claude-lore worker status`);
  }

  console.log(`✓ claude-lore 0.1.0 ready\n`);
}
