#!/usr/bin/env bun
/**
 * claude-lore CI indexer
 *
 * Usage:
 *   CLAUDE_LORE_REPO=/path/to/repo bun run packages/cli/src/ci.ts
 *
 * Env vars:
 *   CLAUDE_LORE_REPO   (required) — canonical repo identifier
 *   CLAUDE_LORE_CWD    (optional) — filesystem path, defaults to process.cwd()
 *   CLAUDE_LORE_PORT   (optional) — worker port, defaults to 37778
 *
 * Exit codes:
 *   0 — success (warnings for orphaned/stale records are non-fatal)
 *   1 — canonical skill has drifted (version_drift conflict)
 *   2 — worker unreachable
 */

const REPO = process.env["CLAUDE_LORE_REPO"];
const CWD = process.env["CLAUDE_LORE_CWD"] ?? process.cwd();
const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";
const BASE = `http://127.0.0.1:${PORT}`;

interface StepResult {
  step: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

if (!REPO) {
  console.error(JSON.stringify({ error: "CLAUDE_LORE_REPO is required" }));
  process.exit(2);
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return res.json();
}

async function runStep(
  name: string,
  fn: () => Promise<unknown>,
): Promise<StepResult> {
  try {
    const data = await fn();
    return { step: name, ok: true, data };
  } catch (err) {
    return { step: name, ok: false, error: String(err) };
  }
}

async function main(): Promise<void> {
  // Preflight: is worker running?
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error("unhealthy");
  } catch {
    console.error(
      JSON.stringify({ error: "Worker not reachable", suggestion: "claude-lore worker start" }),
    );
    process.exit(2);
  }

  const args = { repo: REPO!, cwd: CWD };

  const results: StepResult[] = [];

  results.push(
    await runStep("manifest:sync", () => post("/api/manifest/sync", args)),
  );
  results.push(
    await runStep("staleness:check", () => post("/api/staleness/check", args)),
  );
  results.push(
    await runStep("coverage:generate", () => post("/api/coverage/generate", args)),
  );
  results.push(
    await runStep("skills:index", () => post("/api/skills/index", args)),
  );
  results.push(
    await runStep("advisor:gaps", async () => {
      const res = await fetch(
        `${BASE}/api/advisor/gaps?repo=${encodeURIComponent(REPO!)}&cwd=${encodeURIComponent(CWD)}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      return res.json();
    }),
  );

  // Check for canonical skill drift (version_drift = CI failure)
  const skillsResult = results.find((r) => r.step === "skills:index");
  const skillsData = skillsResult?.data as
    | { conflicts?: Array<{ type: string; skill_name: string }> }
    | undefined;
  const driftedSkills =
    skillsData?.conflicts?.filter((c) => c.type === "version_drift") ?? [];

  // Warnings (non-fatal)
  const stalenessData = results.find((r) => r.step === "staleness:check")?.data as
    | { counts?: Record<string, number> }
    | undefined;
  const orphanedCount = stalenessData?.counts?.orphaned ?? 0;

  const coverageData = results.find((r) => r.step === "coverage:generate")?.data as
    | { summary?: Record<string, number> }
    | undefined;

  const advisorData = results.find((r) => r.step === "advisor:gaps")?.data as
    | { total_gap_score?: number; priority_gaps?: unknown[] }
    | undefined;

  const summary = {
    repo: REPO,
    cwd: CWD,
    steps: results.map((r) => ({ step: r.step, ok: r.ok, error: r.error })),
    warnings: {
      orphaned_anchors: orphanedCount,
    },
    skill_drift: driftedSkills.map((c) => c.skill_name),
    coverage: coverageData?.summary ?? null,
    advisor: {
      total_gap_score: advisorData?.total_gap_score ?? 0,
      priority_gap_count: advisorData?.priority_gaps?.length ?? 0,
    },
    exit_code: driftedSkills.length > 0 ? 1 : 0,
  };

  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

  if (driftedSkills.length > 0) {
    process.stderr.write(
      `CI FAIL: canonical skill(s) have drifted: ${driftedSkills.join(", ")}\n`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: String(err) }));
  process.exit(2);
});
