#!/usr/bin/env node
// beforeShellExecution hook — logs shell commands as observations
import { readFileSync } from "fs";

const PORT = process.env.CLAUDE_LORE_PORT ?? "37778";

async function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync("/dev/stdin", "utf8"));
  } catch {}

  const conversationId = input.conversation_id ?? "unknown";
  const repo = input.cwd ?? input.repo_path ?? process.cwd();
  const command = input.command ?? "";

  if (!command) return;

  try {
    await fetch(`http://127.0.0.1:${PORT}/api/sessions/observations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: conversationId,
        repo,
        tool_name: "Bash",
        content: `Bash: ${command.slice(0, 500)}`,
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
