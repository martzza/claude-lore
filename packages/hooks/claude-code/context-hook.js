#!/usr/bin/env node
// SessionStart hook — fetches prior context from worker and injects it as a system message
import { readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { detectService } from "./detect-service.js";

const PORT = process.env.CLAUDE_LORE_PORT ?? "37778";
const NUDGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync("/dev/stdin", "utf8"));
  } catch {}

  const repo = input.cwd ?? input.repo_path ?? process.cwd();
  const sessionId = input.session_id ?? "unknown";
  const service = detectService(repo);

  // Init the session
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/sessions/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, repo, ...(service ? { service } : {}) }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}

  // Check for a post-session nudge from last session (show once, then delete)
  let nudgeSection = "";
  const nudgePath = join(homedir(), ".codegraph", "last-session-nudge.txt");
  try {
    if (existsSync(nudgePath)) {
      const raw = readFileSync(nudgePath, "utf8");
      const tsMatch = raw.match(/^ts=(\d+)/);
      const ts = tsMatch ? parseInt(tsMatch[1], 10) : 0;
      if (Date.now() - ts < NUDGE_TTL_MS) {
        const lines = raw
          .split("\n")
          .filter((l) => !l.startsWith("ts=") && l.trim().length > 0)
          .map((l) => l.trim());
        if (lines.length > 0) {
          nudgeSection =
            "\n### From last session\n─────────────────────\n" +
            lines.join("\n") +
            "\n";
        }
      }
      // Always delete after reading (show once)
      unlinkSync(nudgePath);
    }
  } catch {}

  // Fetch context to inject
  try {
    const params = new URLSearchParams({ repo });
    if (service) params.set("service", service);
    const res = await fetch(
      `http://127.0.0.1:${PORT}/api/context/inject?${params}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (res.ok) {
      const data = await res.json();
      const context = (data.context ?? "") + nudgeSection;
      if (context.trim()) {
        process.stdout.write(context);
      }
    } else if (nudgeSection) {
      process.stdout.write(nudgeSection);
    }
  } catch {
    if (nudgeSection) {
      process.stdout.write(nudgeSection);
    }
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
