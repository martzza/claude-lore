#!/usr/bin/env node
// Stop hook — triggers AI compression pass (fire and forget)
import { readFileSync } from "fs";

const PORT = process.env.CLAUDE_LORE_PORT ?? "37778";

async function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync("/dev/stdin", "utf8"));
  } catch {}

  const sessionId = input.session_id ?? "unknown";
  const repo = input.cwd ?? input.repo_path ?? process.cwd();

  try {
    await fetch(`http://127.0.0.1:${PORT}/api/sessions/summarise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, repo }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
