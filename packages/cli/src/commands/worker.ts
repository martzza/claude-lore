import { execSync } from "child_process";
import { readFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import {
  findProjectRoot,
  checkHealth,
  pm2Available,
  spawnWorker,
  PID_FILE,
  LOG_FILE,
  ERR_FILE,
} from "../worker-utils.js";

const CLAUDE_LORE_ROOT = findProjectRoot();
const PM2_APP_NAME = "claude-lore-worker";

export async function workerStart(): Promise<void> {
  if (await checkHealth()) {
    console.log("✓ Worker already running on port 37778");
    return;
  }

  if (pm2Available()) {
    const ecosystemConfig = join(CLAUDE_LORE_ROOT, "ecosystem.config.js");
    execSync(`pm2 start ${ecosystemConfig}`, { stdio: "inherit" });
    return;
  }

  console.log("PM2 not found — starting worker directly with bun");
  spawnWorker(CLAUDE_LORE_ROOT);
  console.log(`  Logs: ~/.codegraph/worker.log`);
  console.log(`  To stop: claude-lore worker stop`);

  await Bun.sleep(2000);
  if (!(await checkHealth())) {
    console.error("✗ Worker failed to start — check ~/.codegraph/worker-error.log");
    process.exit(1);
  }
  console.log("✓ Worker healthy on http://127.0.0.1:37778");
}

export async function workerStop(): Promise<void> {
  if (pm2Available()) {
    execSync(`pm2 stop ${PM2_APP_NAME}`, { stdio: "inherit" });
    return;
  }

  if (!existsSync(PID_FILE)) {
    console.log("Worker is not running (no PID file found).");
    return;
  }

  const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  try {
    process.kill(pid, "SIGTERM");
    console.log(`✓ Worker stopped (PID: ${pid})`);
  } catch {
    console.error(`Failed to kill PID ${pid} — process may have already exited.`);
  }
  unlinkSync(PID_FILE);
}

export async function workerStatus(): Promise<void> {
  if (await checkHealth()) {
    console.log("✓ Worker is running on http://127.0.0.1:37778");
    return;
  }

  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    try {
      process.kill(pid, 0);
      console.log(`⚠ Worker process alive (PID: ${pid}) but not responding to health checks`);
    } catch {
      console.log("✗ Worker not running (stale PID file)");
      unlinkSync(PID_FILE);
    }
  } else {
    console.log("✗ Worker not running");
  }
}
