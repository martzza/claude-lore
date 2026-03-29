import { getLastSessionSummary, getOpenDeferredWork } from "../sessions/service.js";
import { analyseKnowledgeGaps } from "../advisor/gaps.js";
import { analyseParallelismFromDeferred } from "../advisor/parallel.js";
import { analyseWorkflow } from "../advisor/workflow.js";
import { findPortfolioForRepo } from "../portfolio/service.js";
import { registryDb } from "../sqlite/db.js";

async function buildPortfolioSection(
  repo: string,
  portfolioName: string,
): Promise<string[]> {
  try {
    // Find symbols this repo exports that appear in other repos in the portfolio
    const consumed = await registryDb.execute({
      sql: `SELECT symbol, repo FROM cross_repo_index
            WHERE portfolio = ? AND repo != ?
            ORDER BY indexed_at DESC
            LIMIT 10`,
      args: [portfolioName, repo],
    });

    // Find symbols from other repos used by this repo (via cross_repo_index)
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

export async function buildContextString(repo: string, cwd?: string): Promise<string> {
  const [lastSession, deferred] = await Promise.all([
    getLastSessionSummary(repo),
    getOpenDeferredWork(repo),
  ]);

  const portfolioName = findPortfolioForRepo(repo);
  const repoBasename = repo.split("/").pop() ?? repo;
  const portfolioTag = portfolioName ? ` [portfolio: ${portfolioName}]` : "";

  const parts: string[] = [`## claude-lore: session context — ${repoBasename}${portfolioTag}\n`];

  // Portfolio cross-repo section (only when repo is linked to a portfolio)
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

  // Advisor section — non-blocking, max 4 lines total, 2-second timeout
  if (cwd) {
    try {
      const [gapAdvisory, parallelAdvisory, workflowAdvisory] = await Promise.race([
        Promise.all([
          analyseKnowledgeGaps(repo, cwd),
          analyseParallelismFromDeferred(repo),
          analyseWorkflow(repo, 60),
        ]),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
      ]);

      const advisorLines: string[] = [];

      if (gapAdvisory.total_gap_score > 0) {
        advisorLines.push(
          `⚠ ${gapAdvisory.priority_gaps.length} knowledge gap(s) (score: ${gapAdvisory.total_gap_score}) — run \`claude-lore advisor gaps\``,
        );
      }

      if (parallelAdvisory.parallel_groups.length > 0) {
        advisorLines.push(
          `🔀 ${parallelAdvisory.analysed_items} deferred items — ${parallelAdvisory.parallel_groups.length} can run in parallel (run \`claude-lore advisor parallel --from-deferred\`)`,
        );
      }

      if (workflowAdvisory.recommendations.length > 0) {
        const topRec = workflowAdvisory.recommendations[0]!;
        advisorLines.push(`📋 Workflow: ${topRec.title}`);
      }

      if (advisorLines.length > 0) {
        parts.push("### claude-lore advisor");
        for (const line of advisorLines.slice(0, 4)) {
          parts.push(line);
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
