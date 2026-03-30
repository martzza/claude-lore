#!/usr/bin/env node
// beforeSubmitPrompt hook — injects prior context once per conversation (lockfile guard)
import { readFileSync, writeFileSync, existsSync } from "fs";
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
  const lockFile = join(tmpdir(), `claude-lore-${conversationId}.lock`);

  // Inject context only once per conversation
  if (existsSync(lockFile)) return;

  try {
    writeFileSync(lockFile, String(Date.now()), { flag: "wx" });
  } catch {
    return; // Another process beat us to it
  }

  // Init session
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/sessions/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: conversationId, repo, ...(service ? { service } : {}) }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}

  // Fetch and inject context
  try {
    const injectParams = new URLSearchParams({ repo });
    if (service) injectParams.set("service", service);
    const res = await fetch(
      `http://127.0.0.1:${PORT}/api/context/inject?${injectParams}`,
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
