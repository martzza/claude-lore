import { execSync } from "child_process";
import { writeFileSync, existsSync, realpathSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// Probe a path, follow symlinks, check for sentinel file one level up from dist/
function tryResolveRoot(candidate: string): string | null {
  try {
    const real = realpathSync(candidate);
    const root = dirname(dirname(real)); // <root>/dist/<binary> → <root>
    if (existsSync(join(root, "ecosystem.config.js"))) return root;
  } catch {}
  return null;
}

export const PID_FILE = join(homedir(), ".codegraph", "worker.pid");
export const LOG_FILE = join(homedir(), ".codegraph", "worker.log");
export const ERR_FILE = join(homedir(), ".codegraph", "worker-error.log");

export function findProjectRoot(): string {
  // 1. Well-known install symlink (created by `pnpm run build:cli`)
  const knownSymlink = join(homedir(), ".bun", "bin", "claude-lore");
  const fromSymlink = tryResolveRoot(knownSymlink);
  if (fromSymlink) return fromSymlink;

  // 2. argv[0] — works when the binary is invoked directly (not via symlink)
  const fromArgv = tryResolveRoot(process.argv[0]);
  if (fromArgv) return fromArgv;

  // 3. Walk upward from cwd — works when running from within the repo
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "ecosystem.config.js"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error("Could not find claude-lore project root (no ecosystem.config.js found)");
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:37778/health", {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function pm2Available(): boolean {
  try {
    execSync("pm2 --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the worker (PM2 if available, else bun background process).
 * Does NOT check if already running — caller should do that first.
 */
export function spawnWorker(loreRoot: string): void {
  if (pm2Available()) {
    const ecosystemConfig = join(loreRoot, "ecosystem.config.js");
    execSync(`pm2 start ${ecosystemConfig}`, { stdio: "inherit" });
    return;
  }

  const proc = Bun.spawn(
    ["bun", "run", "packages/worker/src/index.ts"],
    {
      cwd: loreRoot,
      env: { ...process.env, CLAUDE_LORE_PORT: "37778" },
      stdout: Bun.file(LOG_FILE),
      stderr: Bun.file(ERR_FILE),
    }
  );
  writeFileSync(PID_FILE, String(proc.pid));
}

/**
 * Ensure the worker is running, polling up to maxWaitMs (default 5000).
 * Returns true if healthy, false if it failed to start within the window.
 */
export async function ensureWorkerRunning(
  loreRoot: string,
  maxWaitMs = 5000
): Promise<{ alreadyRunning: boolean; healthy: boolean }> {
  if (await checkHealth()) {
    return { alreadyRunning: true, healthy: true };
  }

  spawnWorker(loreRoot);

  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await Bun.sleep(500);
    if (await checkHealth()) return { alreadyRunning: false, healthy: true };
  }
  return { alreadyRunning: false, healthy: false };
}
