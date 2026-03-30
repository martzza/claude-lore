import { getLastSessionSummary, getOpenDeferredWork } from "../sessions/service.js";
import { analyseKnowledgeGaps } from "../advisor/gaps.js";
import { analyseParallelismFromDeferred } from "../advisor/parallel.js";
import { analyseWorkflow } from "../advisor/workflow.js";
import { analyseClaudeMd } from "../advisor/claudemd.js";
import { findPortfolioForRepo } from "../portfolio/service.js";
import { registryDb } from "../sqlite/db.js";

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

export async function buildContextString(repo: string, cwd?: string, service?: string): Promise<string> {
  const [lastSession, deferred] = await Promise.all([
    getLastSessionSummary(repo, service),
    getOpenDeferredWork(repo, service),
  ]);

  const portfolioName = findPortfolioForRepo(repo);
  const repoBasename = repo.split("/").pop() ?? repo;
  const portfolioTag = portfolioName ? ` [portfolio: ${portfolioName}]` : "";
  const serviceTag = service ? ` · service: ${service}` : "";

  const parts: string[] = [`## claude-lore: session context — ${repoBasename}${portfolioTag}${serviceTag}\n`];

  if (portfolioName) {
    const portfolioLines = await buildPortfolioSection(repo, portfolioName);
    if (portfolioLines.length > 0) parts.push(...portfolioLines);
  }

  if (lastSession?.summary) {
    parts.push(`### Last session summary\n${lastSession.summary}\n`);
  }

  if (deferred.length > 0) {
    parts.push("### Open deferred work");
    for (const item of deferred) {
      const d = item as Record<string, unknown>;
      const symbol = d["symbol"] ? ` *(${String(d["symbol"])})*` : "";
      parts.push(`- ${String(d["content"])}${symbol}`);
    }
    parts.push("");
  }

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
