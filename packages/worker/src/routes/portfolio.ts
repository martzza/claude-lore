import { Router } from "express";
import { z } from "zod";
import { requireScope } from "../middleware/auth.js";
import {
  createPortfolio,
  addRepoToPortfolio,
  removeRepoFromPortfolio,
  listPortfolios,
  getPortfolio,
  findPortfolioForRepo,
} from "../services/portfolio/service.js";
import { generateManifest, syncToRegistry } from "../services/manifest/service.js";
import { registryDb, sessionsDb } from "../services/sqlite/db.js";

const router = Router();

// POST /api/portfolio/create
router.post("/create", requireScope("write:sessions"), (req, res) => {
  const parsed = z
    .object({ name: z.string().min(1), description: z.string().optional() })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    createPortfolio(parsed.data.name, parsed.data.description);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// POST /api/portfolio/add
router.post("/add", requireScope("write:sessions"), async (req, res) => {
  const parsed = z
    .object({ name: z.string().min(1), repo_path: z.string().min(1) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const { name, repo_path } = parsed.data;
    addRepoToPortfolio(name, repo_path);

    const manifest = await generateManifest(repo_path, repo_path);
    await syncToRegistry(manifest, name);

    const symbolCount = [
      ...manifest.exported_decisions,
      ...manifest.exported_deferred,
      ...manifest.exported_risks,
    ].filter((r) => r.symbol).length;

    res.json({ ok: true, symbols_synced: symbolCount });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// POST /api/portfolio/remove
router.post("/remove", requireScope("write:sessions"), (req, res) => {
  const parsed = z
    .object({ name: z.string().min(1), repo_path: z.string().min(1) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    removeRepoFromPortfolio(parsed.data.name, parsed.data.repo_path);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// GET /api/portfolio/list
router.get("/list", async (_req, res) => {
  const portfolios = listPortfolios();

  const enriched = await Promise.all(
    portfolios.map(async (p) => {
      const repoStatuses = await Promise.all(
        p.repos.map(async (repo) => {
          const row = await registryDb.execute({
            sql: `SELECT synced_at FROM repo_manifests WHERE repo = ? AND portfolio = ?`,
            args: [repo, p.name],
          });
          return {
            repo,
            synced_at: row.rows.length > 0 ? (row.rows[0]!["synced_at"] as number) : null,
          };
        }),
      );
      return { ...p, repo_statuses: repoStatuses };
    }),
  );

  // Standalone repos: in registry but not in any named portfolio
  const allRegistryRepos = await registryDb.execute({
    sql: `SELECT DISTINCT repo FROM repo_manifests WHERE portfolio = 'default'`,
    args: [],
  });
  const allPortfolioRepos = new Set(portfolios.flatMap((p) => p.repos));
  const standalone = allRegistryRepos.rows
    .map((r) => String(r["repo"]))
    .filter((r) => !allPortfolioRepos.has(r));

  res.json({ portfolios: enriched, standalone });
});

// POST /api/portfolio/sync
router.post("/sync", requireScope("write:sessions"), async (req, res) => {
  const parsed = z.object({ name: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const portfolio = getPortfolio(parsed.data.name);
  if (!portfolio) {
    res.status(404).json({ error: `Portfolio "${parsed.data.name}" not found` });
    return;
  }

  const results: Array<{ repo: string; symbols: number; error?: string }> = [];
  for (const repo of portfolio.repos) {
    try {
      const manifest = await generateManifest(repo, repo);
      await syncToRegistry(manifest, portfolio.name);
      const symbolCount = [
        ...manifest.exported_decisions,
        ...manifest.exported_deferred,
        ...manifest.exported_risks,
      ].filter((r) => r.symbol).length;
      results.push({ repo, symbols: symbolCount });
    } catch (err) {
      results.push({ repo, symbols: 0, error: String(err) });
    }
  }

  res.json({ ok: true, results });
});

// GET /api/portfolio/status?name=
router.get("/status", async (req, res) => {
  const name = typeof req.query["name"] === "string" ? req.query["name"] : null;
  if (!name) {
    res.status(400).json({ error: "name query param required" });
    return;
  }

  const portfolio = getPortfolio(name);
  if (!portfolio) {
    res.status(404).json({ error: `Portfolio "${name}" not found` });
    return;
  }

  const symbols = await registryDb.execute({
    sql: `SELECT COUNT(*) as cnt FROM cross_repo_index WHERE portfolio = ?`,
    args: [name],
  });
  const symbolCount = Number(symbols.rows[0]?.["cnt"] ?? 0);

  // Symbols appearing in 2+ repos within this portfolio
  const crossLinks = await registryDb.execute({
    sql: `SELECT symbol, GROUP_CONCAT(repo) as repos, COUNT(DISTINCT repo) as repo_count
          FROM cross_repo_index
          WHERE portfolio = ?
          GROUP BY symbol
          HAVING repo_count > 1
          ORDER BY repo_count DESC
          LIMIT 20`,
    args: [name],
  });

  // Risk + deferred counts across all repos in portfolio
  const riskCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  let openDeferred = 0;

  for (const repo of portfolio.repos) {
    const risks = await sessionsDb.execute({
      sql: `SELECT content FROM risks WHERE repo = ?`,
      args: [repo],
    });
    for (const r of risks.rows) {
      const c = String(r["content"] ?? "").toLowerCase();
      if (c.includes("[critical]")) riskCounts.critical++;
      else if (c.includes("[high]")) riskCounts.high++;
      else if (c.includes("[medium]")) riskCounts.medium++;
      else riskCounts.low++;
    }

    const deferred = await sessionsDb.execute({
      sql: `SELECT COUNT(*) as cnt FROM deferred_work WHERE repo = ? AND status = 'open'`,
      args: [repo],
    });
    openDeferred += Number(deferred.rows[0]?.["cnt"] ?? 0);
  }

  res.json({
    name,
    repos: portfolio.repos.length,
    symbols: symbolCount,
    cross_repo_links: crossLinks.rows.length,
    relationships: crossLinks.rows.map((r) => ({
      symbol: String(r["symbol"]),
      repos: String(r["repos"]).split(","),
    })),
    shared_risks: riskCounts,
    open_deferred: openDeferred,
  });
});

// GET /api/portfolio/current?repo= — find which portfolio this repo belongs to
router.get("/current", (req, res) => {
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : undefined;
  if (!repo) {
    res.status(400).json({ error: "repo query param required" });
    return;
  }
  const portfolio = findPortfolioForRepo(repo);
  res.json({ ok: true, portfolio: portfolio ?? null });
});

export default router;
