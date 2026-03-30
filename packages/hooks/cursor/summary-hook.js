#!/usr/bin/env node
// stop hook — triggers AI compression and cleans up lockfile
import { readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectService } from "./detect-service.js";

const PORT = process.env.CLAUDE_LORE_PORT ?? "37778";

async function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync("/dev/stdin", "utf8"));
  } catch {}

  const rawId = String(input.conversation_id ?? "unknown");
  // Sanitise: only alphanumeric, hyphens, underscores — prevents path traversal via ..
  const conversationId = rawId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  const repo = input.cwd ?? input.repo_path ?? process.cwd();
  const service = detectService(repo);

  try {
    await fetch(`http://127.0.0.1:${PORT}/api/sessions/summarise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: conversationId, repo, ...(service ? { service } : {}) }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}

  // Clean up lockfile so next conversation starts fresh
  try {
    rmSync(join(tmpdir(), `claude-lore-${conversationId}.lock`), { force: true });
  } catch {}
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
