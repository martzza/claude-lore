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
        const url = `${BASE}/review?repo=${encodeURIComponent(validPath)}`;
        res.json({ url, message: "Opening review queue" });
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /review?repo=<path> — HTML record review queue
// ─────────────────────────────────────────────────────────────────────────────

import { getPendingRecords } from "../services/reasoning/service.js";

router.get("/review", async (req, res) => {
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : undefined;
  const records = await getPendingRecords(repo).catch(() => []);
  const repoLabel = repo ? repo.split("/").filter(Boolean).pop() ?? repo : "all repos";
  const totalCount = records.length;

  function escHtml(s: unknown): string {
    return String(s ?? "").replace(/[<>&"']/g, (c) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c] ?? c),
    );
  }

  // Severity ranking for sorting and badges
  function severityRank(content: string): number {
    const m = content.match(/^\[(critical|high|medium|low)\]/i);
    if (!m) return 4;
    const s = m[1]!.toLowerCase();
    return s === "critical" ? 0 : s === "high" ? 1 : s === "medium" ? 2 : 3;
  }
  function severityBadge(content: string): string {
    const m = content.match(/^\[(critical|high|medium|low)\]/i);
    if (!m) return "";
    const s = m[1]!.toLowerCase();
    const colour = s === "critical" ? "#ef4444" : s === "high" ? "#f59e0b" : s === "medium" ? "#6366f1" : "#94a3b8";
    return `<span class="sev" style="background:${colour}22;color:${colour};border:1px solid ${colour}44">${s.toUpperCase()}</span>`;
  }
  // Strip [severity] prefix from display content
  function stripSeverity(content: string): string {
    return content.replace(/^\[(critical|high|medium|low)\]\s*/i, "");
  }

  // Importance score for sorting (lower = more important)
  function importanceScore(r: (typeof records)[0]): number {
    const typeOrder: Record<string, number> = { risk: 0, decision: 1, deferred: 2, personal: 3 };
    const typeScore = (typeOrder[r.type] ?? 4) * 10000;
    const sevScore = r.type === "risk" ? severityRank(r.content) * 1000 : 0;
    // Longer content = more meaningful = higher priority (invert length)
    const lengthScore = Math.max(0, 500 - r.content.length);
    return typeScore + sevScore + lengthScore;
  }

  const sorted = [...records].sort((a, b) => importanceScore(a) - importanceScore(b));

  // Group by type in importance order
  const typeOrder = ["risk", "decision", "deferred", "personal"];
  const byType = new Map<string, typeof records>();
  for (const r of sorted) {
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type)!.push(r);
  }

  const typeLabel: Record<string, string> = {
    decision: "Decisions", risk: "Risks", deferred: "Deferred Work", personal: "Personal Notes",
  };
  const typeBorder: Record<string, string> = {
    decision: "#6366f1", risk: "#ef4444", deferred: "#f59e0b", personal: "#94a3b8",
  };
  const confColour: Record<string, string> = {
    confirmed: "#22c55e", extracted: "#6366f1", inferred: "#94a3b8", contested: "#ef4444",
  };

  function renderCards(list: typeof records): string {
    return list.map((r) => {
      const age = r.created_at ? Math.floor((Date.now() - r.created_at) / 86_400_000) : null;
      const ageStr = age !== null ? (age === 0 ? "today" : `${age}d ago`) : "";
      const isDecision = r.table === "decisions";
      const isShort = r.content.trim().length < 30;
      const displayContent = r.type === "risk" ? stripSeverity(r.content) : r.content;
      const cc = confColour[r.confidence] ?? "#94a3b8";
      const sevHtml = r.type === "risk" ? severityBadge(r.content) : "";
      const symHtml = r.symbol
        ? `<span class="sym">${escHtml(r.symbol)}</span>`
        : "";
      const shortWarn = isShort
        ? `<span class="warn-short" title="Content is very short — may be a bootstrap placeholder">⚠ short</span>`
        : "";
      return `<div class="card" id="card-${escHtml(r.id)}" data-id="${escHtml(r.id)}" data-table="${escHtml(r.table)}">
  <div class="card-meta">
    ${sevHtml}
    <span class="conf" style="color:${cc};border-color:${cc}44">${escHtml(r.confidence)}</span>
    ${symHtml}
    ${ageStr ? `<span class="age">${ageStr}</span>` : ""}
    ${shortWarn}
  </div>
  <div class="card-content">${escHtml(displayContent)}</div>
  <button class="expand-btn">Show more</button>
  <div class="card-actions">
    <button class="btn btn-confirm" data-id="${escHtml(r.id)}" data-table="${escHtml(r.table)}" data-action="confirm">✓ Confirm</button>
    <button class="btn btn-dismiss" data-id="${escHtml(r.id)}" data-table="${escHtml(r.table)}" data-action="dismiss">✗ Dismiss</button>
    ${isDecision ? `<button class="btn btn-defer" data-id="${escHtml(r.id)}" data-table="${escHtml(r.table)}" data-action="defer">→ Defer</button>` : ""}
    <button class="btn btn-skip" data-id="${escHtml(r.id)}" data-table="${escHtml(r.table)}" data-action="unknown">Skip</button>
  </div>
  <div class="card-feedback" id="fb-${escHtml(r.id)}"></div>
</div>`;
    }).join("\n");
  }

  const sections = typeOrder
    .filter((t) => byType.has(t))
    .map((type) => {
      const list = byType.get(type)!;
      const colour = typeBorder[type] ?? "#94a3b8";
      const label  = typeLabel[type]  ?? type;
      return `<section>
<h2 class="section-title" style="border-left-color:${colour}">${label} <span class="count">${list.length}</span></h2>
${renderCards(list)}
</section>`;
    }).join("\n");

  const emptyHtml = totalCount === 0
    ? `<div class="empty">No records pending review${repo ? ` for <strong>${escHtml(repoLabel)}</strong>` : ""}.</div>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Review Queue — ${escHtml(repoLabel)}</title>
<style>
:root{--bg:#0f1117;--panel:#1a1d27;--border:#2d3148;--text:#e2e8f0;--muted:#94a3b8;
--green:#22c55e;--amber:#f59e0b;--red:#ef4444;--blue:#6366f1;--radius:8px}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px}
#topbar{background:var(--panel);border-bottom:1px solid var(--border);padding:12px 24px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:10}
#topbar a{color:var(--muted);text-decoration:none;font-size:12px}
#topbar a:hover{color:var(--text)}
h1{font-size:16px;font-weight:700}
#stats{color:var(--muted);font-size:13px;margin-left:auto}
#done-banner{display:none;background:#22c55e22;border:1px solid var(--green);color:var(--green);padding:10px 24px;font-size:13px;text-align:center}
#wrap{max-width:900px;margin:0 auto;padding:24px}
.section-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);border-left:3px solid;padding-left:10px;margin-bottom:12px;margin-top:28px;display:flex;align-items:center;gap:10px}
.count{background:var(--border);color:var(--text);font-size:11px;border-radius:99px;padding:1px 7px;font-weight:600}
.card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;margin-bottom:8px;transition:opacity .25s,border-color .25s}
.card.done{opacity:.35;pointer-events:none;border-color:transparent}
.card.confirmed{border-color:var(--green)!important}
.card.dismissed{border-color:var(--red)!important}
.card.deferred{border-color:var(--amber)!important}
.card-meta{display:flex;align-items:center;gap:7px;margin-bottom:10px;flex-wrap:wrap}
.sev{font-size:10px;font-weight:700;border-radius:3px;padding:2px 6px;letter-spacing:.06em}
.conf{font-size:10px;border-radius:3px;padding:2px 6px;border:1px solid;text-transform:uppercase;letter-spacing:.05em}
.sym{color:var(--blue);font-family:monospace;font-size:11px;background:#6366f122;padding:1px 5px;border-radius:3px}
.age{color:var(--muted);font-size:11px}
.warn-short{font-size:10px;color:var(--amber);border:1px solid #f59e0b44;border-radius:3px;padding:1px 5px}
.card-content{font-size:13px;line-height:1.6;color:var(--text);white-space:pre-wrap;word-break:break-word;margin-bottom:14px;max-height:200px;overflow:hidden;position:relative}
.card-content.expanded{max-height:none}
.expand-btn{font-size:11px;color:var(--blue);cursor:pointer;background:none;border:none;padding:0;margin-bottom:10px;display:none}
.card-actions{display:flex;gap:7px;flex-wrap:wrap}
.btn{border:none;border-radius:5px;padding:6px 13px;font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn:not(:disabled):hover{opacity:.82}
.btn-confirm{background:var(--green);color:#000}
.btn-dismiss{background:var(--red);color:#fff}
.btn-defer{background:var(--amber);color:#000}
.btn-skip{background:var(--border);color:var(--muted)}
.card-feedback{margin-top:8px;font-size:12px;color:var(--muted)}
.empty{color:var(--muted);padding:48px;text-align:center}
#bulk{display:flex;gap:8px;margin-bottom:20px;align-items:center}
#bulk button{background:var(--border);border:none;color:var(--text);padding:5px 13px;border-radius:5px;cursor:pointer;font-size:12px;font-weight:600}
#bulk button:hover{background:var(--blue);color:#fff}
#remaining{font-size:12px;color:var(--muted);margin-left:auto}
section{margin-bottom:4px}
</style>
</head>
<body>
<div id="topbar">
  <a href="/dashboard">← Dashboard</a>
  <h1>Review Queue${repo ? ` — ${escHtml(repoLabel)}` : ""}</h1>
  <span id="stats">${totalCount} record${totalCount !== 1 ? "s" : ""} pending</span>
</div>
<div id="done-banner">All records reviewed — nice work!</div>
<div id="wrap">
${totalCount > 0 ? `<div id="bulk">
  <button onclick="bulkAction('confirm')">✓ Confirm all</button>
  <button onclick="bulkAction('dismiss')">✗ Dismiss all</button>
  <span id="remaining">${totalCount} remaining</span>
</div>` : ""}
${emptyHtml}
${sections}
</div>
<script>
const WORKER = 'http://127.0.0.1:${PORT}';
let remaining = ${totalCount};

// Expand long content on click
document.querySelectorAll('.card-content').forEach(el => {
  if (el.scrollHeight > el.clientHeight + 4) {
    const btn = el.nextElementSibling;
    if (btn && btn.classList.contains('expand-btn')) {
      btn.style.display = 'inline';
      btn.onclick = () => {
        el.classList.toggle('expanded');
        btn.textContent = el.classList.contains('expanded') ? 'Show less' : 'Show more';
      };
    }
  }
});

document.addEventListener('click', ev => {
  const btn = ev.target.closest('.btn[data-action]');
  if (!btn) return;
  act(btn.dataset.id, btn.dataset.table, btn.dataset.action);
});

async function act(id, table, action) {
  const card = document.getElementById('card-' + id);
  const fb   = document.getElementById('fb-' + id);
  if (!card) return;
  card.querySelectorAll('.btn').forEach(b => b.disabled = true);
  fb.textContent = 'Saving\u2026';
  try {
    const resp = await fetch(WORKER + '/api/records/confirm', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ id, table, action }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error ?? 'Request failed');
    const cls = {confirm:'confirmed', dismiss:'dismissed', defer:'deferred'}[action] ?? 'done';
    card.classList.add('done', cls);
    fb.textContent = {confirm:'\u2713 Confirmed', dismiss:'\u2717 Dismissed', defer:'\u2192 Deferred', unknown:'Skipped'}[action] ?? 'Done';
    remaining--;
    const rem = document.getElementById('remaining');
    if (rem) rem.textContent = remaining + ' remaining';
    const stats = document.getElementById('stats');
    if (stats) stats.textContent = remaining + ' record' + (remaining !== 1 ? 's' : '') + ' pending';
    if (remaining === 0) {
      document.getElementById('done-banner').style.display = 'block';
      const bulk = document.getElementById('bulk');
      if (bulk) bulk.style.display = 'none';
    }
  } catch(e) {
    fb.textContent = 'Error: ' + e.message;
    card.querySelectorAll('.btn').forEach(b => b.disabled = false);
  }
}

async function bulkAction(action) {
  for (const card of document.querySelectorAll('.card:not(.done)')) {
    await act(card.dataset.id, card.dataset.table, action);
  }
}
</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
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
