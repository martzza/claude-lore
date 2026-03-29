const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";
const BASE_URL = `http://127.0.0.1:${PORT}`;

interface StatusData {
  repo: string;
  portfolio: string | null;
  worker: { running: boolean; port: number };
  last_session: { summary: string | null; ended_at: number | null; observation_count?: number } | null;
  records: { decisions: number; risks: number; deferred: number; deferred_blocked: number };
  pending_review: number;
  advisor: { gaps: number; claude_md_suggestions: number; parallel_groups: number };
  coverage_pct: number | null;
  open_deferred: Array<{ content: string; symbol?: string; status?: string }>;
}

async function fetchStatus(repo: string, cwd: string): Promise<StatusData> {
  const [
    contextRes,
    advisorRes,
    recordCountRes,
  ] = await Promise.allSettled([
    fetch(`${BASE_URL}/api/context/inject?repo=${encodeURIComponent(repo)}`, {
      signal: AbortSignal.timeout(3000),
    }),
    fetch(`${BASE_URL}/api/advisor/gaps?repo=${encodeURIComponent(repo)}&cwd=${encodeURIComponent(cwd)}`, {
      signal: AbortSignal.timeout(3000),
    }),
    fetch(`${BASE_URL}/api/records/counts?repo=${encodeURIComponent(repo)}`, {
      signal: AbortSignal.timeout(3000),
    }),
  ]);

  // Worker health
  let workerRunning = false;
  try {
    const h = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    workerRunning = h.ok;
  } catch {}

  // Context data (last session + deferred)
  let lastSession = null;
  let openDeferred: StatusData["open_deferred"] = [];
  if (contextRes.status === "fulfilled" && contextRes.value.ok) {
    try {
      const ctx = (await contextRes.value.json()) as Record<string, unknown>;
      lastSession = (ctx["last_session"] as StatusData["last_session"]) ?? null;
      openDeferred = ((ctx["deferred"] ?? []) as unknown[]).map((d) => {
        const r = d as Record<string, unknown>;
        return {
          content: String(r["content"] ?? ""),
          symbol: r["symbol"] ? String(r["symbol"]) : undefined,
          status: r["status"] ? String(r["status"]) : undefined,
        };
      });
    } catch {}
  }

  // Advisor gaps
  let gapCount = 0;
  let claudeMdCount = 0;
  let parallelGroups = 0;
  if (advisorRes.status === "fulfilled" && advisorRes.value.ok) {
    try {
      const g = (await advisorRes.value.json()) as Record<string, unknown>;
      gapCount = Number(g["total_gap_score"] ?? 0);
    } catch {}
  }

  // Try the full advisor summary for richer data
  try {
    const sumRes = await fetch(
      `${BASE_URL}/api/advisor/claudemd?repo=${encodeURIComponent(repo)}&cwd=${encodeURIComponent(cwd)}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (sumRes.ok) {
      const d = (await sumRes.json()) as Record<string, unknown>;
      claudeMdCount = ((d["findings"] as unknown[]) ?? []).length;
    }
  } catch {}

  try {
    const parRes = await fetch(
      `${BASE_URL}/api/advisor/parallel?repo=${encodeURIComponent(repo)}&from_deferred=true`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (parRes.ok) {
      const d = (await parRes.json()) as Record<string, unknown>;
      parallelGroups = ((d["parallel_groups"] as unknown[]) ?? []).length;
    }
  } catch {}

  // Record counts — try the /api/records/counts endpoint, fall back to context
  let decisions = 0;
  let risks = 0;
  let deferred = 0;
  let deferredBlocked = 0;
  let pendingReview = 0;
  if (recordCountRes.status === "fulfilled" && recordCountRes.value.ok) {
    try {
      const d = (await recordCountRes.value.json()) as Record<string, unknown>;
      decisions = Number(d["decisions"] ?? 0);
      risks = Number(d["risks"] ?? 0);
      deferred = Number(d["deferred"] ?? 0);
      deferredBlocked = Number(d["deferred_blocked"] ?? 0);
      pendingReview = Number(d["pending_review"] ?? 0);
    } catch {}
  }

  // Portfolio
  let portfolio: string | null = null;
  try {
    const pRes = await fetch(`${BASE_URL}/api/portfolio/current?repo=${encodeURIComponent(repo)}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (pRes.ok) {
      const pd = (await pRes.json()) as Record<string, unknown>;
      portfolio = pd["portfolio"] ? String(pd["portfolio"]) : null;
    }
  } catch {}

  return {
    repo,
    portfolio,
    worker: { running: workerRunning, port: parseInt(PORT, 10) },
    last_session: lastSession,
    records: { decisions, risks, deferred, deferred_blocked: deferredBlocked },
    pending_review: pendingReview,
    advisor: { gaps: gapCount, claude_md_suggestions: claudeMdCount, parallel_groups: parallelGroups },
    coverage_pct: null,
    open_deferred: openDeferred,
  };
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export async function runStatus(opts: { json?: boolean }): Promise<void> {
  const repo = process.cwd();
  const repoName = repo.split("/").pop() ?? repo;

  let data: StatusData;
  try {
    data = await fetchStatus(repo, repo);
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ error: String(err) }));
    } else {
      console.error("Failed to fetch status:", err);
    }
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const portfolioStr = data.portfolio ? ` · portfolio: ${data.portfolio}` : "";
  console.log(`\n${repoName}${portfolioStr}`);
  console.log("─────────────────────────────────────────");

  // Worker
  const workerStr = data.worker.running
    ? `✓ running on port ${data.worker.port}`
    : `✗ NOT RUNNING — start with: claude-lore worker start`;
  console.log(`Worker        ${workerStr}`);

  // Last session
  if (data.last_session?.ended_at) {
    const ago = formatTimeAgo(data.last_session.ended_at);
    console.log(`Last session  ${ago}`);
  } else {
    console.log(`Last session  no sessions yet`);
  }

  // Records
  const { decisions, risks, deferred, deferred_blocked } = data.records;
  const blockedNote = deferred_blocked > 0 ? ` (${deferred_blocked} blocked)` : "";
  console.log(`Records       ${decisions} decision${decisions !== 1 ? "s" : ""} · ${risks} risk${risks !== 1 ? "s" : ""} · ${deferred} deferred${blockedNote}`);

  // Pending review
  if (data.pending_review > 0) {
    console.log(`Pending       ${data.pending_review} record${data.pending_review !== 1 ? "s" : ""} need review → claude-lore review`);
  }

  // Advisor
  const advisorParts = [];
  if (data.advisor.gaps > 0) advisorParts.push(`${data.advisor.gaps} gap${data.advisor.gaps !== 1 ? "s" : ""}`);
  if (data.advisor.claude_md_suggestions > 0) advisorParts.push(`CLAUDE.md suggestion`);
  if (data.advisor.parallel_groups > 0) advisorParts.push(`${data.advisor.parallel_groups} task${data.advisor.parallel_groups !== 1 ? "s" : ""} parallelisable`);
  if (advisorParts.length > 0) {
    console.log(`Advisor       ${advisorParts.join(" · ")}`);
  }

  // Coverage
  if (data.coverage_pct !== null) {
    console.log(`Coverage      ${data.coverage_pct}% of symbols have reasoning records`);
  }

  // Open deferred
  if (data.open_deferred.length > 0) {
    console.log();
    console.log("OPEN DEFERRED (showing up to 3)");
    const shown = data.open_deferred.slice(0, 3);
    for (const item of shown) {
      const blocked = item.status === "blocked" ? " (blocked)" : "";
      console.log(`• ${item.content.slice(0, 70)}${blocked}`);
    }
    const rest = data.open_deferred.length - 3;
    if (rest > 0) {
      console.log(`  … ${rest} more → claude-lore review`);
    }
  }

  console.log();
  console.log("Run claude-lore help for all available commands.\n");
}
