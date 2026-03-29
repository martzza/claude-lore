#!/usr/bin/env node
// UserPromptSubmit hook — detects decision/risk/deferral keywords and logs observations
import { readFileSync } from "fs";

const PORT = process.env.CLAUDE_LORE_PORT ?? "37778";

const DECISION_PATTERNS = [
  /\bdecid(e|ed|ing)\b/i,
  /\barchitect(ure|ural)?\b/i,
  /\bwe (should|will|are going to)\b/i,
  /\bgoing with\b/i,
  /\bchoosing\b/i,
];

const RISK_PATTERNS = [
  /\brisk\b/i,
  /\bdanger(ous)?\b/i,
  /\bbreaking change\b/i,
  /\bcaution\b/i,
  /\bwatch out\b/i,
];

const DEFER_PATTERNS = [
  /\bdefer\b/i,
  /\btodo\b/i,
  /\blater\b/i,
  /\bskipping for now\b/i,
  /\bparking\b/i,
  /\bfollow.?up\b/i,
];

async function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync("/dev/stdin", "utf8"));
  } catch {}

  const prompt = input.prompt ?? "";
  const sessionId = input.session_id ?? "unknown";
  const repo = input.cwd ?? input.repo_path ?? process.cwd();

  const matchedDecision = DECISION_PATTERNS.some((p) => p.test(prompt));
  const matchedRisk = RISK_PATTERNS.some((p) => p.test(prompt));
  const matchedDefer = DEFER_PATTERNS.some((p) => p.test(prompt));

  if (!matchedDecision && !matchedRisk && !matchedDefer) return;

  const tags = [
    matchedDecision ? "decision" : null,
    matchedRisk ? "risk" : null,
    matchedDefer ? "deferred" : null,
  ]
    .filter(Boolean)
    .join(",");

  try {
    await fetch(`http://127.0.0.1:${PORT}/api/sessions/observations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        repo,
        tool_name: `intent:${tags}`,
        content: prompt.slice(0, 2000),
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
