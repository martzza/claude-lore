#!/usr/bin/env node
// UserPromptSubmit hook — detects decision/risk/deferral/planning keywords and logs observations
import { readFileSync } from "fs";
import { detectService } from "./detect-service.js";

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

const PLANNING_SIGNALS = [
  /what should i work on/i,
  /what'?s next/i,
  /where should i start/i,
  /what to do next/i,
  /help me plan/i,
  /what'?s the priority/i,
  /what can i do in parallel/i,
  /should i work on/i,
  /what('s| is) the next step/i,
  /where do i start/i,
];

async function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync("/dev/stdin", "utf8"));
  } catch {}

  const prompt = input.prompt ?? "";
  const sessionId = input.session_id ?? "unknown";
  const repo = input.cwd ?? input.repo_path ?? process.cwd();
  const service = detectService(repo);

  const matchedDecision = DECISION_PATTERNS.some((p) => p.test(prompt));
  const matchedRisk = RISK_PATTERNS.some((p) => p.test(prompt));
  const matchedDefer = DEFER_PATTERNS.some((p) => p.test(prompt));
  const matchedPlanning = PLANNING_SIGNALS.some((p) => p.test(prompt));

  const observations = [];

  // Log decision/risk/defer intent
  if (matchedDecision || matchedRisk || matchedDefer) {
    const tags = [
      matchedDecision ? "decision" : null,
      matchedRisk ? "risk" : null,
      matchedDefer ? "deferred" : null,
    ]
      .filter(Boolean)
      .join(",");
    observations.push({ tool_name: `intent:${tags}`, content: prompt.slice(0, 2000) });
  }

  // Log planning signal (triggers advisor cache pre-warm in worker)
  if (matchedPlanning) {
    const signals = PLANNING_SIGNALS.filter((p) => p.test(prompt)).map((p) => p.source);
    observations.push({
      tool_name: "planning-signal",
      content: JSON.stringify({ prompt: prompt.slice(0, 500), signals }),
    });
  }

  for (const obs of observations) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/api/sessions/observations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          repo,
          tool_name: obs.tool_name,
          content: obs.content,
          ...(service ? { service } : {}),
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {}
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
