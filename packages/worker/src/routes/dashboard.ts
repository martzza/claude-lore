import { Router } from "express";
import { isAbsolute, resolve } from "path";
import { execFileSync } from "child_process";
import { getMcpStats } from "../mcp/server.js";
import { checkVersion } from "../services/dashboard/version-check.js";
import { assembleSummary } from "../services/dashboard/summary.js";
import { renderDashboard } from "../services/dashboard/renderer.js";
import { analyseKnowledgeGaps } from "../services/advisor/gaps.js";
import { registryDb } from "../services/sqlite/db.js";

const router = Router();

const PORT = parseInt(process.env["CLAUDE_LORE_PORT"] ?? "37778", 10);
const BASE = `http://127.0.0.1:${PORT}`;

// ─────────────────────────────────────────────────────────────────────────────
// GET /dashboard — HTML page
// ─────────────────────────────────────────────────────────────────────────────

router.get("/dashboard", async (_req, res) => {
  try {
    const summary = await assembleSummary();
    const html = renderDashboard(summary);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    res.status(500).send(`<pre>Dashboard error: ${String(err)}</pre>`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/mcp/stats
// ─────────────────────────────────────────────────────────────────────────────

router.get("/api/mcp/stats", (_req, res) => {
  res.json(getMcpStats());
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/dashboard/version-check
// ─────────────────────────────────────────────────────────────────────────────

router.get("/api/dashboard/version-check", async (_req, res) => {
  try {
    const result = await checkVersion();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/dashboard/summary
// ─────────────────────────────────────────────────────────────────────────────

router.get("/api/dashboard/summary", async (_req, res) => {
  try {
    const summary = await assembleSummary();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/portfolio/report
// ─────────────────────────────────────────────────────────────────────────────

router.post("/api/portfolio/report", async (req, res) => {
  const { name, format } = req.body as { name?: string; format?: string };
  const portfolioName = name ?? "default";

  try {
    const summary = await assembleSummary();
    const repos = summary.repos.filter(
      (r) => r.portfolio === portfolioName || portfolioName === "default",
    );

    const now = new Date().toISOString();
    const totalRecords = repos.reduce((s, r) => s + r.records.total, 0);
    const totalPending = repos.reduce((s, r) => s + r.records.pending_review, 0);
    const lastActivity = repos
      .map((r) => r.last_session?.ended_at ?? 0)
      .reduce((a, b) => Math.max(a, b), 0);

    const lines: string[] = [];

    lines.push(`# Portfolio Report: ${portfolioName}`);
    lines.push(`Generated: ${now}`);
    lines.push("");

    // Portfolio Overview
    lines.push("## Portfolio Overview");
    lines.push(`- **Repos:** ${repos.length}`);
    lines.push(`- **Total records:** ${totalRecords}`);
    lines.push(`- **Pending review:** ${totalPending}`);
    lines.push(`- **Last activity:** ${lastActivity ? new Date(lastActivity).toLocaleString() : "none"}`);
    lines.push("");

    // Repo Status Table
    lines.push("## Repo Status");
    lines.push("| Name | Status | Records | Pending | Indexed |");
    lines.push("|------|--------|---------|---------|---------|");
    for (const r of repos) {
      lines.push(
        `| ${r.name} | ${r.status.label} | ${r.records.total} | ${r.records.pending_review} | ${r.structural.exists ? "✓" : "✗"} |`,
      );
    }
    lines.push("");

    // Pending Reviews
    lines.push("## Pending Reviews");
    const withPending = repos.filter((r) => r.records.pending_review > 0);
    if (withPending.length === 0) {
      lines.push("No pending reviews.");
    } else {
      for (const r of withPending) {
        lines.push(`- **${r.name}**: ${r.records.pending_review} pending`);
      }
    }
    lines.push("");

    // Advisor Findings
    lines.push("## Advisor Findings");
    const withAdvisor = repos.filter((r) => (r.advisor.gap_score ?? 0) > 0);
    if (withAdvisor.length === 0) {
      lines.push("No advisor gaps found.");
    } else {
      for (const r of withAdvisor.sort((a, b) => b.advisor.gap_score - a.advisor.gap_score)) {
        lines.push(`- **${r.name}**: gap score ${r.advisor.gap_score} (${r.advisor.priority_gaps} priority, ${r.advisor.quick_wins} quick wins)`);
      }
    }
    lines.push("");

    // Cross-Repo Risks
    lines.push("## Cross-Repo Risks");
    const riskyRepos = repos.filter((r) => r.critical_risks.length > 0);
    if (riskyRepos.length === 0) {
      lines.push("No cross-repo risks found.");
    } else {
      for (const r of riskyRepos) {
        for (const risk of r.critical_risks) {
          lines.push(`- **${r.name}**: ${risk.content}`);
        }
      }
    }
    lines.push("");

    // Open Deferred Items
    lines.push("## Open Deferred Items");
    const withDeferred = repos.filter((r) => r.open_deferred.length > 0);
    if (withDeferred.length === 0) {
      lines.push("No open deferred items.");
    } else {
      for (const r of withDeferred) {
        for (const d of r.open_deferred) {
          lines.push(`- **${r.name}**: ${d.content}`);
        }
      }
    }
    lines.push("");

    const markdown = lines.join("\n");

    if (format === "json") {
      res.json({ name: portfolioName, content: markdown, repos: repos.length });
      return;
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="portfolio-report-${portfolioName}.md"`,
    );
    res.send(markdown);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/dashboard/action
// ─────────────────────────────────────────────────────────────────────────────

function validateRepoPath(p: unknown): string | null {
  if (typeof p !== "string") return null;
  if (!p || !isAbsolute(p) || resolve(p) !== p) return null;
  return p;
}

router.post("/api/dashboard/action", async (req, res) => {
  const { action, repo_path } = req.body as { action?: string; repo_path?: string };

  if (!action) {
    res.status(400).json({ error: "action is required" });
    return;
  }

  // Actions that require a valid repo_path
  const needsPath = ["run_index", "sync_manifest", "open_review", "open_folder", "run_advisor"];
  if (needsPath.includes(action)) {
    const validPath = validateRepoPath(repo_path);
    if (!validPath) {
      res.status(400).json({ error: "repo_path must be a safe absolute path" });
      return;
    }

    switch (action) {
      case "run_index": {
        try {
          const r = await fetch(`${BASE}/api/structural/index`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repo: validPath, cwd: validPath }),
            signal: AbortSignal.timeout(30_000),
          });
          const data = await r.json() as unknown;
          res.json({ ok: r.ok, message: "Index complete", data });
        } catch (err) {
          res.status(500).json({ error: String(err) });
        }
        return;
      }

      case "sync_manifest": {
        try {
          const r = await fetch(`${BASE}/api/manifest/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repo: validPath }),
            signal: AbortSignal.timeout(15_000),
          });
          const data = await r.json() as unknown;
          res.json({ ok: r.ok, message: "Manifest synced", data });
        } catch (err) {
          res.status(500).json({ error: String(err) });
        }
        return;
      }

      case "open_review": {
        const url = `${BASE}/api/records?repo=${encodeURIComponent(validPath)}&format=html`;
        res.json({ url, message: "Review queue URL generated" });
        return;
      }

      case "open_folder": {
        try {
          const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
          execFileSync(openCmd, [validPath], { timeout: 5000 });
          res.json({ ok: true, message: "Opened folder" });
        } catch (err) {
          res.status(500).json({ error: String(err) });
        }
        return;
      }

      case "run_advisor": {
        try {
          const result = await Promise.race([
            analyseKnowledgeGaps(validPath, validPath),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("timeout")), 15_000),
            ),
          ]);
          res.json({ ok: true, message: "Advisor complete", result });
        } catch (err) {
          res.status(500).json({ error: String(err) });
        }
        return;
      }
    }
  }

  // Global actions (no repo_path required)
  switch (action) {
    case "index_all": {
      let manifests: Array<{ repo: string }> = [];
      try {
        const r = await registryDb.execute({
          sql: "SELECT repo FROM repo_manifests",
          args: [],
        });
        manifests = r.rows.map((row) => ({ repo: String(row["repo"]) }));
      } catch { /* ok */ }

      const results: Array<{ repo: string; ok: boolean; error?: string }> = [];
      for (const m of manifests) {
        const p = validateRepoPath(m.repo);
        if (!p) continue;
        try {
          const r = await fetch(`${BASE}/api/structural/index`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repo: p, cwd: p }),
            signal: AbortSignal.timeout(60_000),
          });
          results.push({ repo: m.repo, ok: r.ok });
        } catch (err) {
          results.push({ repo: m.repo, ok: false, error: String(err) });
        }
      }
      res.json({ ok: true, message: `Indexed ${results.length} repos`, results });
      return;
    }

    case "sync_all": {
      let manifests: Array<{ repo: string }> = [];
      try {
        const r = await registryDb.execute({
          sql: "SELECT repo FROM repo_manifests",
          args: [],
        });
        manifests = r.rows.map((row) => ({ repo: String(row["repo"]) }));
      } catch { /* ok */ }

      const results: Array<{ repo: string; ok: boolean; error?: string }> = [];
      for (const m of manifests) {
        const p = validateRepoPath(m.repo);
        if (!p) continue;
        try {
          const r = await fetch(`${BASE}/api/manifest/sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repo: p }),
            signal: AbortSignal.timeout(15_000),
          });
          results.push({ repo: m.repo, ok: r.ok });
        } catch (err) {
          results.push({ repo: m.repo, ok: false, error: String(err) });
        }
      }
      res.json({ ok: true, message: `Synced ${results.length} repos`, results });
      return;
    }

    case "update": {
      try {
        // Run git pull then pnpm install in the claude-lore root
        const loreRoot = findLoreRoot();
        if (loreRoot) {
          execFileSync("git", ["-C", loreRoot, "pull"], { timeout: 30_000 });
          execFileSync("pnpm", ["install"], { cwd: loreRoot, timeout: 60_000 });
        }
        res.json({ ok: true, message: "Update complete — restart worker to apply" });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
      return;
    }

    default:
      res.status(400).json({ error: `Unknown action: ${action}` });
  }
});

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

function findLoreRoot(): string | null {
  const candidates = [
    process.cwd(),
    join(homedir(), "Documents", "claude-lore"),
    join(homedir(), "projects", "claude-lore"),
    join(homedir(), "code", "claude-lore"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "packages", "worker"))) return c;
  }
  return null;
}

export default router;
