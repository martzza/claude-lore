#!/usr/bin/env node
// PostToolUse hook — logs Write/Edit/Bash observations to the worker
import { readFileSync } from "fs";

const PORT = process.env.CLAUDE_LORE_PORT ?? "37778";

// Only log observations for tools that indicate meaningful work
const OBSERVED_TOOLS = new Set(["Write", "Edit", "Bash", "NotebookEdit"]);

async function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync("/dev/stdin", "utf8"));
  } catch {}

  const toolName = input.tool_name ?? input.tool ?? "";
  if (!OBSERVED_TOOLS.has(toolName)) return;

  const sessionId = input.session_id ?? "unknown";
  const repo = input.cwd ?? input.repo_path ?? process.cwd();

  // Build a compact content summary from tool input
  let content = "";
  const toolInput = input.tool_input ?? {};
  if (toolName === "Write" || toolName === "Edit") {
    content = `${toolName} ${toolInput.file_path ?? toolInput.path ?? "(unknown file)"}`;
  } else if (toolName === "Bash") {
    content = `Bash: ${String(toolInput.command ?? "").slice(0, 500)}`;
  } else {
    content = `${toolName}: ${JSON.stringify(toolInput).slice(0, 500)}`;
  }

  try {
    await fetch(`http://127.0.0.1:${PORT}/api/sessions/observations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, repo, tool_name: toolName, content }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
