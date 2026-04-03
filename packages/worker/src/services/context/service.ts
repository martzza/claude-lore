import { getLastSessionSummary } from "../sessions/service.js";
import { analyseKnowledgeGaps } from "../advisor/gaps.js";
import { analyseParallelismFromDeferred } from "../advisor/parallel.js";
import { analyseWorkflow } from "../advisor/workflow.js";
import { analyseClaudeMd } from "../advisor/claudemd.js";
import { findPortfolioForRepo } from "../portfolio/service.js";
import { sessionsDb, registryDb } from "../sqlite/db.js";
import { getInjectableMemories } from "../memory/service.js";
import { isHistorical, stalenessScore, STALENESS_THRESHOLDS } from "../../types/lifecycle.js";

// ---------------------------------------------------------------------------
// In-memory advisor cache (pre-warmed on planning-signal observations)
// ---------------------------------------------------------------------------

interface CachedAdvisor {
  lines: string[];
  expires: number;
}

const advisorCache = new Map<string, CachedAdvisor>();
const ADVISOR_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function computeAdvisorLines(repo: string, cwd: string): Promise<string[]> {
  const [gapAdvisory, parallelAdvisory, workflowAdvisory, claudeMdAnalysis] = await Promise.all([
    analyseKnowledgeGaps(repo, cwd),
    analyseParallelismFromDeferred(repo),
    analyseWorkflow(repo, 60),
    analyseClaudeMd(repo, cwd).catch(() => null),
  ]);

  const lines: string[] = [];

  // Priority 1: critical knowledge gaps
  if (gapAdvisory.total_gap_score >= 10 && gapAdvisory.priority_gaps.length > 0) {
    const top = gapAdvisory.priority_gaps[0];
    lines.push(
      `⚠  ${gapAdvisory.priority_gaps.length} critical gap${gapAdvisory.priority_gaps.length !== 1 ? "s" : ""} (score: ${gapAdvisory.total_gap_score})${top ? ` — e.g. "${top.description?.slice(0, 60) ?? ""}"` : ""} — run \`claude-lore advisor gaps\``,
    );
  } else if (gapAdvisory.total_gap_score > 0) {
    lines.push(
      `⚠  ${gapAdvisory.priority_gaps.length + gapAdvisory.quick_wins.length} knowledge gap(s) (score: ${gapAdvisory.total_gap_score}) — run \`claude-lore advisor gaps\``,
    );
  }

  // Priority 2: workflow patterns
  if (workflowAdvisory.recommendations.length > 0) {
    const topRec = workflowAdvisory.recommendations[0]!;
    lines.push(`📋 Workflow pattern (${workflowAdvisory.sessions_analysed} sessions): ${topRec.title}`);
    if (topRec.rationale) {
      lines.push(`   ${topRec.rationale.slice(0, 100)}`);
    }
  }

  // Priority 3: CLAUDE.md issues
  if (claudeMdAnalysis?.findings && claudeMdAnalysis.findings.length > 0) {
    const redundant = claudeMdAnalysis.findings.filter((f) => f.type === "redundant");
    const missing = claudeMdAnalysis.findings.filter((f) => f.type === "missing");
    const optimise = claudeMdAnalysis.findings.filter((f) => f.type === "optimise");
    if (optimise.length > 0 && claudeMdAnalysis.token_estimate > 0) {
      lines.push(
        `💡 CLAUDE.md is ~${claudeMdAnalysis.token_estimate} tokens. Run: \`claude-lore advisor claudemd --apply\``,
      );
    } else if (redundant.length > 0) {
      lines.push(
        `💡 CLAUDE.md has ${redundant.length} section${redundant.length !== 1 ? "s" : ""} that may duplicate graph records. Run: \`claude-lore advisor claudemd --apply\``,
      );
    } else if (missing.length > 0) {
      lines.push(
        `💡 CLAUDE.md is missing ${missing.length} section${missing.length !== 1 ? "s" : ""}. Run: \`claude-lore advisor claudemd --apply\``,
      );
    }
  }

  // Priority 4: parallelism opportunities
  if (parallelAdvisory.parallel_groups.length > 0) {
    const group = parallelAdvisory.parallel_groups[0];
    const taskNames = group?.tasks.slice(0, 3).map((t) => `"${t.description.slice(0, 40)}"`) ?? [];
    lines.push(
      `🔀 ${parallelAdvisory.analysed_items} deferred items — ${parallelAdvisory.parallel_groups.length} group${parallelAdvisory.parallel_groups.length !== 1 ? "s" : ""} can run in parallel:`,
    );
    for (const name of taskNames) {
      lines.push(`   ${name}`);
    }
    lines.push("   Run: `claude-lore advisor parallel --from-deferred`");
  }

  return lines;
}

export function warmAdvisorCache(repo: string, cwd: string, service?: string): void {
  const cacheKey = `${repo}::${service ?? ""}`;
  computeAdvisorLines(repo, cwd)
    .then((lines) => {
      advisorCache.set(cacheKey, { lines, expires: Date.now() + ADVISOR_CACHE_TTL });
    })
    .catch(() => {});
}

async function getAdvisorLines(repo: string, cwd: string, service?: string): Promise<string[]> {
  const cacheKey = `${repo}::${service ?? ""}`;
  const cached = advisorCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.lines;
  }
  return computeAdvisorLines(repo, cwd);
}

// ---------------------------------------------------------------------------
// Portfolio section
// ---------------------------------------------------------------------------

async function buildPortfolioSection(
  repo: string,
  portfolioName: string,
): Promise<string[]> {
  try {
    const depends = await registryDb.execute({
      sql: `SELECT symbol, repo FROM cross_repo_index
            WHERE portfolio = ? AND repo != ?
              AND (lifecycle_status IS NULL OR lifecycle_status = 'active')
            ORDER BY indexed_at DESC
            LIMIT 10`,
      args: [portfolioName, repo],
    });

    const lines: string[] = [`### Cross-repo dependencies [portfolio: ${portfolioName}]`];

    if (depends.rows.length > 0) {
      const byRepo = new Map<string, string[]>();
      for (const r of depends.rows) {
        const rrepo = String(r["repo"]);
        const sym = String(r["symbol"]);
        const key = rrepo.split("/").pop() ?? rrepo;
        if (!byRepo.has(key)) byRepo.set(key, []);
        byRepo.get(key)!.push(sym);
      }
      lines.push(
        "Peers: " +
          Array.from(byRepo.entries())
            .map(([name, syms]) => `${name} (${syms.slice(0, 3).join(", ")})`)
            .join(", "),
      );
    } else {
      lines.push("Peers: (none synced yet)");
    }

    lines.push("");
    return lines;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main context builder
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Lifecycle-aware record queries for context injection
// ---------------------------------------------------------------------------

const DECISION_CAP   = 10;
const DEFERRED_CAP   = 8;
const DEFERRED_OLD_CAP = 3;  // max "possibly completed" items
const RISK_CAP       = 5;

function severityRank(content: string): number {
  const l = content.toLowerCase();
  if (l.includes("[critical]")) return 0;
  if (l.includes("[high]"))     return 1;
  if (l.includes("[medium]"))   return 2;
  return 3;
}

async function buildDecisionsSection(repo: string, service?: string): Promise<string[]> {
  const svcClause = service !== undefined ? " AND service IS ?" : "";
  const args: (string | null)[] = [repo, ...(service !== undefined ? [service] : [])];
  const res = await sessionsDb.execute({
    sql: `SELECT id, content, confidence, created_at, last_reviewed_at, superseded_by
          FROM decisions
          WHERE repo = ? AND lifecycle_status = 'active' AND deprecated_by IS NULL${svcClause}
          ORDER BY
            CASE confidence WHEN 'confirmed' THEN 0 WHEN 'extracted' THEN 1 ELSE 2 END,
            created_at DESC
          LIMIT 50`,
    args,
  });

  if (res.rows.length === 0) return [];

  const nowSec = Date.now() / 1000;
  const threshold = STALENESS_THRESHOLDS["decision"];
  const active: string[] = [];
  const historical: string[] = [];

  for (const row of res.rows) {
    const r = row as Record<string, unknown>;
    const content   = String(r["content"] ?? "");
    const conf      = String(r["confidence"] ?? "extracted");
    const createdAt = Number(r["created_at"] ?? 0) / 1000; // stored as ms
    const lastReview = r["last_reviewed_at"] != null ? Number(r["last_reviewed_at"]) : null;
    const age = nowSec - createdAt;

    const confLabel = conf === "confirmed" ? "[confirmed]" : conf === "inferred" ? "[inferred]" : "[extracted]";
    const short = content.slice(0, 120) + (content.length > 120 ? "…" : "");

    if (age > threshold && (lastReview === null || nowSec - lastReview > threshold)) {
      historical.push(`- [historical] ${confLabel} ${short}`);
    } else {
      active.push(`- ${confLabel} ${short}`);
    }
  }

  const shownActive = active.slice(0, DECISION_CAP);
  const shownHistorical = historical.slice(0, Math.max(0, DECISION_CAP - shownActive.length));
  const totalCount = res.rows.length;

  const lines: string[] = [
    `### Active decisions (${shownActive.length + shownHistorical.length} of ${totalCount})`,
  ];
  lines.push(...shownActive, ...shownHistorical);
  if (totalCount > DECISION_CAP) {
    lines.push(`*(${totalCount - DECISION_CAP} more — run \`claude-lore review\`)*`);
  }
  lines.push("");
  return lines;
}

async function buildDeferredSection(repo: string, service?: string): Promise<string[]> {
  const svcClause = service !== undefined ? " AND service IS ?" : "";
  const args: (string | null)[] = [repo, ...(service !== undefined ? [service] : [])];
  const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const res = await sessionsDb.execute({
    sql: `SELECT id, content, symbol, blocked_by, created_at, touched_by_sessions
          FROM deferred_work
          WHERE repo = ? AND lifecycle_status = 'active' AND deprecated_by IS NULL${svcClause}
          ORDER BY blocked_by IS NOT NULL DESC, created_at DESC`,
    args,
  });

  if (res.rows.length === 0) return [];

  const current: string[] = [];
  const possiblyDone: string[] = [];

  for (const row of res.rows) {
    const r = row as Record<string, unknown>;
    const content   = String(r["content"] ?? "");
    const symbol    = r["symbol"] != null ? ` *(${String(r["symbol"])})*` : "";
    const blockedBy = r["blocked_by"] != null ? String(r["blocked_by"]) : null;
    const createdAt = Number(r["created_at"] ?? 0);
    const touched   = JSON.parse(String(r["touched_by_sessions"] ?? "[]")) as string[];
    const isOld     = createdAt < cutoffMs;
    const short     = content.slice(0, 100) + (content.length > 100 ? "…" : "");

    if (!isOld || blockedBy) {
      const blockLabel = blockedBy ? ` *(blocked)*` : "";
      current.push(`- ${short}${symbol}${blockLabel}`);
    } else if (possiblyDone.length < DEFERRED_OLD_CAP) {
      const touchLabel = touched.length >= 2 ? ` ⚡ touched in ${touched.length} sessions` : "";
      possiblyDone.push(`- ${short}${symbol}${touchLabel}`);
    }
  }

  const shownCurrent = current.slice(0, DEFERRED_CAP);
  const totalCount   = res.rows.length;
  const lines: string[] = [`### Open deferred work (${shownCurrent.length} of ${totalCount})`];
  lines.push(...shownCurrent);

  if (possiblyDone.length > 0) {
    lines.push(`*[possibly completed — ${possiblyDone.length} item${possiblyDone.length !== 1 ? "s" : ""} older than 30 days — run \`claude-lore review\`]*`);
    lines.push(...possiblyDone);
  }
  if (totalCount > DEFERRED_CAP) {
    lines.push(`*(${totalCount - DEFERRED_CAP} more — run \`claude-lore review\`)*`);
  }
  lines.push("");
  return lines;
}

async function buildRisksSection(repo: string, service?: string): Promise<string[]> {
  const svcClause = service !== undefined ? " AND service IS ?" : "";
  const args: (string | null)[] = [repo, ...(service !== undefined ? [service] : [])];
  const res = await sessionsDb.execute({
    sql: `SELECT id, content, confidence, created_at, last_reviewed_at
          FROM risks
          WHERE repo = ? AND lifecycle_status = 'active' AND deprecated_by IS NULL${svcClause}
          ORDER BY created_at DESC
          LIMIT 50`,
    args,
  });

  if (res.rows.length === 0) return [];

  const nowSec      = Date.now() / 1000;
  const riskThresh  = STALENESS_THRESHOLDS["risk"];
  const rows = (res.rows as Record<string, unknown>[]).sort((a, b) => {
    const sa = severityRank(String(a["content"] ?? ""));
    const sb = severityRank(String(b["content"] ?? ""));
    if (sa !== sb) return sa - sb;
    // Within same severity: confirmed first
    const ca = String(a["confidence"] ?? ""); const cb = String(b["confidence"] ?? "");
    return (ca === "confirmed" ? 0 : 1) - (cb === "confirmed" ? 0 : 1);
  });

  const lines: string[] = [`### Active risks (top ${Math.min(rows.length, RISK_CAP)})`];
  let shown = 0;
  for (const r of rows) {
    if (shown >= RISK_CAP) break;
    const content    = String(r["content"] ?? "");
    const conf       = String(r["confidence"] ?? "extracted");
    const createdAt  = Number(r["created_at"] ?? 0) / 1000;
    const lastReview = r["last_reviewed_at"] != null ? Number(r["last_reviewed_at"]) : null;
    const age        = nowSec - createdAt;
    const sev        = content.match(/\[(critical|high|medium|low)\]/i)?.[1]?.toUpperCase() ?? "LOW";
    const clean      = content.replace(/^\[(critical|high|medium|low)\]\s*/i, "");
    const short      = clean.slice(0, 100) + (clean.length > 100 ? "…" : "");
    const confLabel  = conf === "confirmed" ? "confirmed" : conf;
    const stale      = age > riskThresh && (lastReview === null || nowSec - lastReview > riskThresh);
    const staleLabel = stale ? " [unverified]" : "";
    lines.push(`- [${sev} · ${confLabel}]${staleLabel} ${short}`);
    shown++;
  }
  if (rows.length > RISK_CAP) {
    lines.push(`*(${rows.length - RISK_CAP} more risks — run \`claude-lore advisor gaps\`)*`);
  }
  lines.push("");
  return lines;
}

export async function buildContextString(repo: string, cwd?: string, service?: string): Promise<string> {
  const lastSession = await getLastSessionSummary(repo, service);

  const portfolioName = findPortfolioForRepo(repo);
  const repoBasename = repo.split("/").pop() ?? repo;
  const portfolioTag = portfolioName ? ` [portfolio: ${portfolioName}]` : "";
  const serviceTag = service ? ` · service: ${service}` : "";

  const parts: string[] = [`## claude-lore: session context — ${repoBasename}${portfolioTag}${serviceTag}\n`];

  // Global memories — personal, cross-repo, always injected first
  try {
    const globalMemories = await getInjectableMemories();
    if (globalMemories.length > 0) {
      const MAX_MEMORIES = 20;
      const shown = globalMemories.slice(0, MAX_MEMORIES);
      const memLines: string[] = ["### Personal notes — always present"];
      for (const m of shown) {
        const tagLabel = m.tags ? ` *(${m.tags})*` : "";
        memLines.push(`- ${m.content}${tagLabel}`);
      }
      if (globalMemories.length > MAX_MEMORIES) {
        memLines.push(
          `*(${globalMemories.length - MAX_MEMORIES} more — run \`claude-lore memories\`)*`,
        );
      }
      memLines.push("");
      parts.push(memLines.join("\n"));
    }
  } catch {
    // personal.db unavailable — skip silently
  }

  if (portfolioName) {
    const portfolioLines = await buildPortfolioSection(repo, portfolioName);
    if (portfolioLines.length > 0) parts.push(...portfolioLines);
  }

  if (lastSession?.summary) {
    parts.push(`### Last session summary\n${lastSession.summary}\n`);
  }

  // Lifecycle-aware record sections
  const [decisionsLines, deferredLines, risksLines] = await Promise.all([
    buildDecisionsSection(repo, service),
    buildDeferredSection(repo, service),
    buildRisksSection(repo, service),
  ]);
  if (decisionsLines.length > 0) parts.push(decisionsLines.join("\n"));
  if (deferredLines.length > 0)  parts.push(deferredLines.join("\n"));
  if (risksLines.length > 0)     parts.push(risksLines.join("\n"));

  // Advisor section — non-blocking, max 6 lines, 2-second timeout
  if (cwd) {
    try {
      const advisorLines = await Promise.race([
        getAdvisorLines(repo, cwd, service),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
      ]);

      if (advisorLines.length > 0) {
        const MAX_ADVISOR_LINES = 6;
        const shown = advisorLines.slice(0, MAX_ADVISOR_LINES);
        const overflow = advisorLines.length - MAX_ADVISOR_LINES;

        parts.push("### What claude-lore suggests");
        parts.push("─────────────────────────────");
        for (const line of shown) {
          parts.push(line);
        }
        if (overflow > 0) {
          parts.push(`\nRun \`claude-lore advisor\` for full recommendations (${overflow} more)`);
        }
        parts.push("");
      }
    } catch {
      // timeout or analysis error — skip advisor section silently
    }
  }

  if (parts.length === 1) {
    return ""; // nothing to inject — first session for this repo
  }

  return parts.join("\n");
}
