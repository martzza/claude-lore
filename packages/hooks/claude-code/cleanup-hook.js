#!/usr/bin/env node
// SessionEnd hook — marks session complete
import { readFileSync } from "fs";
import { detectService } from "./detect-service.js";

const PORT = process.env.CLAUDE_LORE_PORT ?? "37778";

async function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync("/dev/stdin", "utf8"));
  } catch {}

  const sessionId = input.session_id ?? "unknown";
  const repo = input.cwd ?? input.repo_path ?? process.cwd();
  const service = detectService(repo);

  try {
    await fetch(`http://127.0.0.1:${PORT}/api/sessions/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, repo, ...(service ? { service } : {}) }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
