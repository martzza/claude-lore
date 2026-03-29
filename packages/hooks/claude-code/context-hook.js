#!/usr/bin/env node
// SessionStart hook — fetches prior context from worker and injects it as a system message
import { readFileSync } from "fs";

const PORT = process.env.CLAUDE_LORE_PORT ?? "37778";

async function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync("/dev/stdin", "utf8"));
  } catch {}

  const repo = input.cwd ?? input.repo_path ?? process.cwd();
  const sessionId = input.session_id ?? "unknown";

  // Init the session
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/sessions/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, repo }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}

  // Fetch context to inject
  try {
    const res = await fetch(
      `http://127.0.0.1:${PORT}/api/context/inject?repo=${encodeURIComponent(repo)}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (res.ok) {
      const data = await res.json();
      if (data.context) {
        process.stdout.write(data.context);
      }
    }
  } catch {}
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
