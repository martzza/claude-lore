import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registryDb } from "../../services/sqlite/db.js";
import { findPortfolioForRepo } from "../../services/portfolio/service.js";

export function registerPortfolioTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // portfolio_deps(repo, portfolio?) — exports + portfolio peers
  // -------------------------------------------------------------------------
  server.tool(
    "portfolio_deps",
    "Show what a repo publishes to the registry and list all other repos in the same portfolio.",
    {
      repo: z.string().describe("Repo path to inspect"),
      portfolio: z
        .string()
        .optional()
        .describe(
          "Portfolio name to scope the query. If omitted, auto-detected from the repo.",
        ),
    },
    async ({ repo, portfolio }) => {
      const portfolioName = portfolio ?? findPortfolioForRepo(repo) ?? "default";

      const manifestRow = await registryDb.execute({
        sql: `SELECT manifest FROM repo_manifests WHERE repo = ? AND portfolio = ?`,
        args: [repo, portfolioName],
      });

      // Fall back to any portfolio if the explicit one has no entry yet
      const manifestFallback =
        manifestRow.rows.length === 0
          ? await registryDb.execute({
              sql: `SELECT manifest FROM repo_manifests WHERE repo = ? LIMIT 1`,
              args: [repo],
            })
          : manifestRow;

      const allRepos = await registryDb.execute({
        sql: `SELECT repo, synced_at FROM repo_manifests WHERE portfolio = ? ORDER BY synced_at DESC`,
        args: [portfolioName],
      });

      const repoManifest =
        manifestFallback.rows.length > 0
          ? JSON.parse(String(manifestFallback.rows[0]!["manifest"]))
          : null;

      const exports = repoManifest
        ? {
            decisions: (repoManifest.exported_decisions ?? []).length,
            deferred: (repoManifest.exported_deferred ?? []).length,
            risks: (repoManifest.exported_risks ?? []).length,
            version: repoManifest.version,
          }
        : null;

      const mySymbols = await registryDb.execute({
        sql: `SELECT symbol, tier FROM cross_repo_index WHERE repo = ? AND portfolio = ?`,
        args: [repo, portfolioName],
      });

      const result = {
        repo,
        portfolio: portfolioName,
        exports,
        exported_symbols: mySymbols.rows.map((r) => ({
          symbol: r["symbol"],
          tier: r["tier"],
        })),
        portfolio_peers: allRepos.rows
          .filter((r) => r["repo"] !== repo)
          .map((r) => ({
            repo: r["repo"],
            synced_at: r["synced_at"],
          })),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // portfolio_impact(symbol, repo?, portfolio?) — cross-repo blast radius
  // -------------------------------------------------------------------------
  server.tool(
    "portfolio_impact",
    "Trace the cross-repo blast radius of a symbol within a portfolio.",
    {
      symbol: z.string().describe("Symbol name to trace"),
      repo: z.string().optional().describe("Origin repo (used to label the source)"),
      portfolio: z
        .string()
        .optional()
        .describe("Portfolio name to scope the query. If omitted, auto-detected from repo."),
    },
    async ({ symbol, repo, portfolio }) => {
      const portfolioName =
        portfolio ?? (repo ? (findPortfolioForRepo(repo) ?? undefined) : undefined);

      const portfolioFilter = portfolioName
        ? `AND portfolio = '${portfolioName.replace(/'/g, "''")}'`
        : "";

      const exact = await registryDb.execute({
        sql: `SELECT symbol, repo, tier, signature, indexed_at, portfolio
              FROM cross_repo_index
              WHERE symbol = ? ${portfolioFilter}
              ORDER BY indexed_at DESC`,
        args: [symbol],
      });

      const prefix = await registryDb.execute({
        sql: `SELECT symbol, repo, tier, signature, indexed_at, portfolio
              FROM cross_repo_index
              WHERE symbol LIKE ? AND symbol != ? ${portfolioFilter}
              ORDER BY indexed_at DESC
              LIMIT 20`,
        args: [`${symbol}%`, symbol],
      });

      const result = {
        symbol,
        origin_repo: repo ?? null,
        portfolio: portfolioName ?? null,
        exact_matches: exact.rows,
        prefix_matches: prefix.rows,
        affected_repos: [
          ...new Set([
            ...exact.rows.map((r) => r["repo"]),
            ...prefix.rows.map((r) => r["repo"]),
          ]),
        ],
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // portfolio_context(task, portfolio?) — cross-repo reasoning search
  // -------------------------------------------------------------------------
  server.tool(
    "portfolio_context",
    "Query the portfolio-wide knowledge graph for a task. Returns relevant reasoning records from all repos in the portfolio, respecting visibility tiers.",
    {
      task: z.string().describe("Natural language task or question to find context for"),
      portfolio: z
        .string()
        .optional()
        .describe(
          "Portfolio name to scope the search. If omitted, searches all portfolios.",
        ),
    },
    async ({ task, portfolio }) => {
      const allManifests = portfolio
        ? await registryDb.execute({
            sql: `SELECT repo, manifest FROM repo_manifests WHERE portfolio = ? ORDER BY synced_at DESC`,
            args: [portfolio],
          })
        : await registryDb.execute({
            sql: `SELECT repo, manifest FROM repo_manifests ORDER BY synced_at DESC`,
            args: [],
          });

      const terms = task
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 3);

      const matches: Array<{
        repo: string;
        record_type: string;
        tier: string;
        symbol: string | null;
        content: string | null;
        confidence: string | null;
        score: number;
      }> = [];

      for (const manifestRow of allManifests.rows) {
        const repo = String(manifestRow["repo"]);
        let manifest: {
          exported_decisions: Array<{
            symbol: string | null;
            content: string | null;
            confidence: string | null;
            exported_tier: string;
          }>;
          exported_deferred: Array<{
            symbol: string | null;
            content: string | null;
            confidence: string | null;
            exported_tier: string;
          }>;
          exported_risks: Array<{
            symbol: string | null;
            content: string | null;
            confidence: string | null;
            exported_tier: string;
          }>;
        };
        try {
          manifest = JSON.parse(String(manifestRow["manifest"]));
        } catch {
          continue;
        }

        const allRecords = [
          ...manifest.exported_decisions.map((r) => ({ ...r, record_type: "decision" })),
          ...manifest.exported_deferred.map((r) => ({ ...r, record_type: "deferred" })),
          ...manifest.exported_risks.map((r) => ({ ...r, record_type: "risk" })),
        ];

        for (const record of allRecords) {
          if (!record.content) continue;
          const haystack = `${record.content} ${record.symbol ?? ""}`.toLowerCase();
          const score = terms.filter((t) => haystack.includes(t)).length;
          if (score > 0) {
            matches.push({
              repo,
              record_type: record.record_type,
              tier: record.exported_tier,
              symbol: record.symbol ?? null,
              content: record.content,
              confidence: record.confidence ?? null,
              score,
            });
          }
        }
      }

      matches.sort((a, b) => b.score - a.score);

      const result = {
        task,
        portfolio: portfolio ?? "all",
        repos_searched: allManifests.rows.length,
        matches: matches.slice(0, 30),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
