#!/usr/bin/env node
// Stop hook — triggers AI compression pass and writes post-session nudge if warranted
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const PORT = process.env.CLAUDE_LORE_PORT ?? "37778";

async function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync("/dev/stdin", "utf8"));
  } catch {}

  const sessionId = input.session_id ?? "unknown";
  const repo = input.cwd ?? input.repo_path ?? process.cwd();

  // Trigger compression pass
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/sessions/summarise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, repo }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}

  // Fetch session stats for nudge logic
  try {
    const statsRes = await fetch(
      `http://127.0.0.1:${PORT}/api/sessions/stats?session_id=${encodeURIComponent(sessionId)}&repo=${encodeURIComponent(repo)}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!statsRes.ok) return;

    const stats = await statsRes.json();
    const { observation_count, modules_touched, unconfirmed_decisions } = stats;

    const nudgeLines = [];

    if (modules_touched >= 3) {
      nudgeLines.push(
        `Last session touched ${modules_touched} modules — consider batching related work.`,
      );
    }
    if (unconfirmed_decisions >= 2) {
      nudgeLines.push(
        `${unconfirmed_decisions} decisions were captured but not confirmed — run: claude-lore review`,
      );
    }
    if (observation_count > 10 && modules_touched >= 3) {
      nudgeLines.push(
        `High-activity session (${observation_count} observations). Consider leading with high-impact changes next session.`,
      );
    }

    if (nudgeLines.length > 0) {
      const nudgePath = join(homedir(), ".codegraph", "last-session-nudge.txt");
      const content = `ts=${Date.now()}\n${nudgeLines.join("\n")}\n`;
      try {
        mkdirSync(dirname(nudgePath), { recursive: true });
        writeFileSync(nudgePath, content, "utf8");
      } catch {}
    }
  } catch {}
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
