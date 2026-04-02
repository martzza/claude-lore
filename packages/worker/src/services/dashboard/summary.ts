import { existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { sessionsDb, registryDb, getTursoStatus } from "../sqlite/db.js";
import { getStructuralClient } from "../structural/db-cache.js";
import { analyseKnowledgeGaps } from "../advisor/gaps.js";
import { getMcpStats } from "../../mcp/server.js";
import { checkVersion } from "./version-check.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RepoStatus {
  code:  "healthy" | "needs_attention" | "issues" | "initialised";
  label: string;
}

export interface SetupStep {
  step:      number;   // 1-5
  label:     string;
  complete:  boolean;
}

export interface LoreQuality {
  confirmed:  number;
  extracted:  number;
  inferred:   number;
  contested:  number;
  total:      number;
  maturity:   "early" | "developing" | "mature";
}

export interface StructuralInfo {
  exists:        boolean;
  symbol_count:  number;
  edge_count:    number;
  indexed_at:    number | null;
}

export interface GitInfo {
  branch:       string | null;
  dirty:        boolean;
  last_commit:  string | null;
  last_commit_relative: string | null;
}

export interface RepoSummary {
  name:            string;
  path:            string;
  portfolio:       string;
  status:          RepoStatus;
  setup_steps:     SetupStep[];
  git:             GitInfo;
  records: {
    decisions:       number;
    risks:           number;
    deferred_open:   number;
    confirmed:       number;
    pending_review:  number;
    total:           number;
  };
  lore_quality:         LoreQuality;
  structural:           StructuralInfo;
  top_decisions:        Array<{ id: string; content: string; symbol: string | null }>;
  critical_risks:       Array<{ id: string; content: string; symbol: string | null }>;
  open_deferred:        Array<{ id: string; content: string }>;
  last_session: {
    ended_at:  number | null;
    summary:   string | null;
  };
  session_sparkline:    number[];   // counts per day, last 14 days
  sessions_total:       number;
  advisor: {
    gap_score:     number;
    priority_gaps: number;
    quick_wins:    number;
  };
  cross_repo: {
    exports_to:    string[];
    imports_from:  string[];
  };
  synced_at:  number | null;
}

export interface PortfolioSummary {
  name:        string;
  repos:       string[];
  repo_count:  number;
}

export interface ActivityEvent {
  type:       "session_ended" | "manifest_synced" | "record_created";
  repo:       string;
  timestamp:  number;
  detail:     string;
}

export interface SystemSummary {
  version: string;
  worker: {
    running:         boolean;
    port:            number;
    uptime_seconds:  number;
    mode:            "solo" | "team";
  };
  mcp: {
    tool_count:    number;
    total_calls:   number;
    last_call_at:  number | null;
    calls_today:   number;
  };
  databases: {
    sessions: { ok: boolean; row_count: number };
    registry: { ok: boolean; row_count: number };
    personal: { ok: boolean; row_count: number };
  };
  ai_compression: {
    api_key_set:   boolean;
    sessions_compressed: number;
  };
  turso: {
    connected:  boolean;
    sync_url:   string | null;
  };
  pm2: {
    running:     boolean;
    uptime_ms:   number | null;
    memory_mb:   number | null;
    cpu_percent: number | null;
    restarts:    number | null;
  };
  environment: {
    CLAUDE_LORE_PORT:         "set" | "not_set";
    CLAUDE_LORE_TURSO_URL:    "set" | "not_set";
    CLAUDE_LORE_AUTH_TOKEN:   "set" | "not_set";
    ANTHROPIC_API_KEY:        "set" | "not_set";
  };
  update_check: import("./version-check.js").VersionCheckResult;
  binary: {
    path:    string | null;
    exists:  boolean;
  };
  review_queue: {
    total_pending: number;
    by_repo: Array<{
      repo:          string;
      pending:       number;
      oldest_age_days: number | null;
    }>;
  };
}

export interface DashboardSummary {
  generated_at:  number;
  repos:         RepoSummary[];
  portfolios:    PortfolioSummary[];
  standalone:    string[];   // repos not in any named portfolio
  totals: {
    decisions:      number;
    risks:          number;
    deferred:       number;
    sessions:       number;
    pending_review: number;
  };
  activity_feed: ActivityEvent[];
  system:        SystemSummary;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const PORT = parseInt(process.env["CLAUDE_LORE_PORT"] ?? "37778", 10);
const WORKER_START = Date.now(); // approximation — module load time

function repoName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function execGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      timeout: 2000,
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function getGitInfo(repoPath: string): GitInfo {
  const branch = execGit(repoPath, ["branch", "--show-current"]) || null;
  const status = execGit(repoPath, ["status", "--porcelain"]);
  const dirty = status.length > 0;
  const log = execGit(repoPath, ["log", "-1", "--format=%s|%cr"]);
  const [lastCommit, lastRel] = log.includes("|") ? log.split("|") : [log || null, null];
  return {
    branch,
    dirty,
    last_commit:          lastCommit ?? null,
    last_commit_relative: lastRel ?? null,
  };
}

function getPm2Stats(): SystemSummary["pm2"] {
  try {
    const raw = execFileSync("pm2", ["jlist"], { timeout: 4000, encoding: "utf8" });
    const procs = JSON.parse(raw) as Array<Record<string, unknown>>;
    for (const p of procs) {
      const name = String(p["name"] ?? "");
      if (!name.includes("claude-lore")) continue;
      const env = p["pm2_env"] as Record<string, unknown> | undefined;
      const monit = p["monit"] as Record<string, unknown> | undefined;
      return {
        running:     String(env?.["status"] ?? "") === "online",
        uptime_ms:   typeof env?.["pm_uptime"] === "number" ? Date.now() - (env["pm_uptime"] as number) : null,
        memory_mb:   typeof monit?.["memory"] === "number" ? Math.round((monit["memory"] as number) / 1024 / 1024) : null,
        cpu_percent: typeof monit?.["cpu"] === "number" ? (monit["cpu"] as number) : null,
        restarts:    typeof env?.["restart_time"] === "number" ? (env["restart_time"] as number) : null,
      };
    }
  } catch { /* pm2 not available */ }
  return { running: false, uptime_ms: null, memory_mb: null, cpu_percent: null, restarts: null };
}

async function getStructuralInfo(repoPath: string): Promise<StructuralInfo> {
  const dbPath = join(repoPath, ".codegraph", "structural.db");
  if (!existsSync(dbPath)) {
    return { exists: false, symbol_count: 0, edge_count: 0, indexed_at: null };
  }
  const db = getStructuralClient(dbPath);
  if (!db) return { exists: false, symbol_count: 0, edge_count: 0, indexed_at: null };
  try {
    const r = await db.execute({ sql: "SELECT * FROM index_meta LIMIT 1", args: [] });
    if (r.rows.length === 0) return { exists: true, symbol_count: 0, edge_count: 0, indexed_at: null };
    const row = r.rows[0]!;
    return {
      exists:       true,
      symbol_count: Number(row["symbol_count"] ?? 0),
      edge_count:   Number(row["edge_count"] ?? 0),
      indexed_at:   row["indexed_at"] != null ? Number(row["indexed_at"]) : null,
    };
  } catch {
    // Fallback: count symbols and edges directly
    try {
      const sc = await db.execute({ sql: "SELECT COUNT(*) as n FROM symbols", args: [] });
      const ec = await db.execute({ sql: "SELECT COUNT(*) as n FROM call_graph", args: [] });
      return {
        exists:       true,
        symbol_count: Number(sc.rows[0]?.["n"] ?? 0),
        edge_count:   Number(ec.rows[0]?.["n"] ?? 0),
        indexed_at:   null,
      };
    } catch {
      return { exists: true, symbol_count: 0, edge_count: 0, indexed_at: null };
    }
  }
}

async function getSessionSparkline(repo: string): Promise<number[]> {
  const days: number[] = new Array(14).fill(0);
  try {
    const cutoff = Date.now() - 14 * MS_PER_DAY;
    const r = await sessionsDb.execute({
      sql: `SELECT ended_at FROM sessions WHERE repo = ? AND ended_at > ? ORDER BY ended_at`,
      args: [repo, cutoff],
    });
    for (const row of r.rows) {
      const ea = Number(row["ended_at"] ?? 0);
      if (!ea) continue;
      const dayIdx = Math.floor((Date.now() - ea) / MS_PER_DAY);
      const i = 13 - dayIdx;
      if (i >= 0 && i < 14) days[i]!++;
    }
  } catch { /* ok */ }
  return days;
}

function computeStatus(
  syncedAt: number | null,
  structural: StructuralInfo,
  records: RepoSummary["records"],
  sessionsCount: number,
  stuckSessions: number,
  setupStep: number,
  lastSessionAge: number | null,
): RepoStatus {
  const now = Date.now();

  if (setupStep === 1) {
    return { code: "initialised", label: "Initialised — bootstrap not run" };
  }
  if (records.total === 0) {
    return { code: "issues", label: "No records — bootstrap never run" };
  }
  if (stuckSessions > 0) {
    return { code: "issues", label: `${stuckSessions} stuck session${stuckSessions > 1 ? "s" : ""}` };
  }

  const manifestStale = !syncedAt || (now - syncedAt > 24 * 60 * 60 * 1000);
  const noStructural  = !structural.exists;
  const highPending   = records.pending_review > 10;
  const inactiveLong  = lastSessionAge !== null && lastSessionAge > 7 * MS_PER_DAY;
  const noSessions    = sessionsCount === 0;

  if (manifestStale || noStructural || highPending || inactiveLong || noSessions || setupStep < 4) {
    const reasons: string[] = [];
    if (manifestStale)  reasons.push("manifest stale");
    if (noStructural)   reasons.push("not indexed");
    if (highPending)    reasons.push(`${records.pending_review} pending reviews`);
    if (inactiveLong)   reasons.push("inactive > 7d");
    if (noSessions)     reasons.push("no sessions");
    return { code: "needs_attention", label: reasons.join(", ") || "needs attention" };
  }

  return { code: "healthy", label: "Healthy" };
}

function computeSetupSteps(
  repoPath: string,
  totalRecords: number,
  structural: StructuralInfo,
  sessionsCount: number,
  confirmedCount: number,
): SetupStep[] {
  const hasCodegraph = existsSync(join(repoPath, ".codegraph"));
  return [
    { step: 1, label: "init",       complete: hasCodegraph },
    { step: 2, label: "bootstrap",  complete: totalRecords > 0 },
    { step: 3, label: "indexed",    complete: structural.exists },
    { step: 4, label: "active",     complete: sessionsCount > 0 },
    { step: 5, label: "mature",     complete: confirmedCount > 0 },
  ];
}

function computeLoreQuality(
  confirmed: number,
  extracted: number,
  inferred: number,
  contested: number,
): LoreQuality {
  const total = confirmed + extracted + inferred + contested;
  const pct = total > 0 ? confirmed / total : 0;
  const maturity: LoreQuality["maturity"] =
    pct > 0.7 ? "mature" : pct >= 0.3 ? "developing" : "early";
  return { confirmed, extracted, inferred, contested, total, maturity };
}

// ---------------------------------------------------------------------------
// Main assembly
// ---------------------------------------------------------------------------

export async function assembleSummary(): Promise<DashboardSummary> {
  const now = Date.now();

  // ── 1. Load all registered repos from registry ──────────────────────────
  let manifests: Array<{ repo: string; synced_at: number; portfolio: string; manifest_obj: Record<string, unknown> }> = [];
  try {
    const r = await registryDb.execute({ sql: "SELECT repo, manifest, synced_at, portfolio FROM repo_manifests", args: [] });
    for (const row of r.rows) {
      let manifest_obj: Record<string, unknown> = {};
      try { manifest_obj = JSON.parse(String(row["manifest"] ?? "{}")); } catch { /* ok */ }
      manifests.push({
        repo:       String(row["repo"]),
        synced_at:  Number(row["synced_at"] ?? 0),
        portfolio:  String(row["portfolio"] ?? "default"),
        manifest_obj,
      });
    }
  } catch { /* registry empty */ }

  // ── 2. Per-repo record counts from sessions.db ──────────────────────────
  async function groupCount(table: string, whereExtra = ""): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
      const r = await sessionsDb.execute({
        sql: `SELECT repo, COUNT(*) as c FROM ${table} ${whereExtra} GROUP BY repo`,
        args: [],
      });
      for (const row of r.rows) map.set(String(row["repo"]), Number(row["c"] ?? 0));
    } catch { /* ok */ }
    return map;
  }

  const [decisionsMap, risksMap, deferredMap, confirmedMap, pendingMap, sessionsCountMap] =
    await Promise.all([
      groupCount("decisions"),
      groupCount("risks"),
      groupCount("deferred_work", "WHERE status='open'"),
      groupCount("decisions", "WHERE confidence='confirmed'"),
      groupCount("decisions", "WHERE confidence='extracted' AND (pending_review IS NULL OR pending_review = 0) AND deprecated_by IS NULL"),
      groupCount("sessions"),
    ]);

  // Pending review across all tables
  const pendingRisksMap = await groupCount("risks", "WHERE confidence='extracted' AND deprecated_by IS NULL");
  const pendingDeferredMap = await groupCount("deferred_work", "WHERE confidence='extracted' AND status='open' AND deprecated_by IS NULL");

  // Pending review by repo: sum across all tables
  const allPendingRepos = new Set([...pendingMap.keys(), ...pendingRisksMap.keys(), ...pendingDeferredMap.keys()]);
  const allPendingByRepo = new Map<string, number>();
  for (const r of allPendingRepos) {
    allPendingByRepo.set(r, (pendingMap.get(r) ?? 0) + (pendingRisksMap.get(r) ?? 0) + (pendingDeferredMap.get(r) ?? 0));
  }

  // Lore quality by confidence level per repo
  async function confidenceBreakdown(table: string): Promise<Map<string, Record<string, number>>> {
    const map = new Map<string, Record<string, number>>();
    try {
      const r = await sessionsDb.execute({
        sql: `SELECT repo, confidence, COUNT(*) as c FROM ${table} GROUP BY repo, confidence`,
        args: [],
      });
      for (const row of r.rows) {
        const repo = String(row["repo"]);
        if (!map.has(repo)) map.set(repo, {});
        map.get(repo)![String(row["confidence"])] = Number(row["c"] ?? 0);
      }
    } catch { /* ok */ }
    return map;
  }

  const [dConfidence, rConfidence, dfConfidence] = await Promise.all([
    confidenceBreakdown("decisions"),
    confidenceBreakdown("risks"),
    confidenceBreakdown("deferred_work"),
  ]);

  // Last session per repo
  let lastSessionMap = new Map<string, { ended_at: number; summary: string | null }>();
  try {
    const r = await sessionsDb.execute({
      sql: `SELECT repo, ended_at, summary FROM sessions WHERE ended_at IS NOT NULL ORDER BY ended_at DESC`,
      args: [],
    });
    for (const row of r.rows) {
      const repo = String(row["repo"]);
      if (!lastSessionMap.has(repo)) {
        lastSessionMap.set(repo, {
          ended_at: Number(row["ended_at"]),
          summary:  row["summary"] != null ? String(row["summary"]) : null,
        });
      }
    }
  } catch { /* ok */ }

  // Activity feed — last 20 sessions ended
  let activityFeed: ActivityEvent[] = [];
  try {
    const r = await sessionsDb.execute({
      sql: `SELECT repo, ended_at, summary FROM sessions WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 20`,
      args: [],
    });
    for (const row of r.rows) {
      activityFeed.push({
        type:      "session_ended",
        repo:      String(row["repo"]),
        timestamp: Number(row["ended_at"] ?? 0),
        detail:    row["summary"] ? String(row["summary"]).slice(0, 120) : "Session ended",
      });
    }
  } catch { /* ok */ }

  // Manifest sync events
  for (const m of manifests) {
    if (m.synced_at > 0) {
      activityFeed.push({
        type:      "manifest_synced",
        repo:      m.repo,
        timestamp: m.synced_at,
        detail:    "Manifest synced",
      });
    }
  }
  activityFeed.sort((a, b) => b.timestamp - a.timestamp);
  activityFeed = activityFeed.slice(0, 20);

  // Cross-repo index: exports/imports per repo
  const crossExportsMap  = new Map<string, string[]>();
  const crossImportsMap  = new Map<string, string[]>();
  try {
    const r = await registryDb.execute({ sql: "SELECT symbol, repo FROM cross_repo_index", args: [] });
    for (const row of r.rows) {
      const repo = String(row["repo"]);
      if (!crossExportsMap.has(repo)) crossExportsMap.set(repo, []);
      crossExportsMap.get(repo)!.push(String(row["symbol"]));
    }
  } catch { /* ok */ }

  // ── 3. Assemble per-repo summaries ──────────────────────────────────────
  const repoSummaries: RepoSummary[] = [];

  // Advisor calls with timeout
  const advisorPromises = manifests.map(async (m) => {
    const repoPath = m.repo; // repo is stored as path in registry
    try {
      const r = await Promise.race([
        analyseKnowledgeGaps(repoPath, repoPath),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
      ]);
      return { repo: m.repo, result: r };
    } catch {
      return { repo: m.repo, result: null };
    }
  });
  const advisorResults = await Promise.allSettled(advisorPromises);
  const advisorMap = new Map<string, { gap_score: number; priority_gaps: number; quick_wins: number }>();
  for (const r of advisorResults) {
    if (r.status === "fulfilled" && r.value.result) {
      advisorMap.set(r.value.repo, {
        gap_score:     r.value.result.total_gap_score,
        priority_gaps: r.value.result.priority_gaps.length,
        quick_wins:    r.value.result.quick_wins.length,
      });
    }
  }

  // Stuck sessions count per repo
  let stuckMap = new Map<string, number>();
  try {
    const r = await sessionsDb.execute({
      sql: `SELECT repo, COUNT(*) as c FROM sessions WHERE status='active' AND started_at < (unixepoch() - 3600) GROUP BY repo`,
      args: [],
    });
    for (const row of r.rows) stuckMap.set(String(row["repo"]), Number(row["c"] ?? 0));
  } catch { /* ok */ }

  // Top decisions, critical risks, open deferred per repo (LIMIT 3/2/3)
  const topDecisionsMap  = new Map<string, Array<{ id: string; content: string; symbol: string | null }>>();
  const critRisksMap     = new Map<string, Array<{ id: string; content: string; symbol: string | null }>>();
  const openDeferredMap  = new Map<string, Array<{ id: string; content: string }>>();

  try {
    const r = await sessionsDb.execute({
      sql: `SELECT id, repo, content, symbol FROM decisions WHERE confidence='confirmed' ORDER BY created_at DESC`,
      args: [],
    });
    for (const row of r.rows) {
      const repo = String(row["repo"]);
      if (!topDecisionsMap.has(repo)) topDecisionsMap.set(repo, []);
      const arr = topDecisionsMap.get(repo)!;
      if (arr.length < 3) arr.push({ id: String(row["id"]), content: String(row["content"]).slice(0, 150), symbol: row["symbol"] != null ? String(row["symbol"]) : null });
    }
  } catch { /* ok */ }

  try {
    const r = await sessionsDb.execute({
      sql: `SELECT id, repo, content, symbol FROM risks WHERE deprecated_by IS NULL ORDER BY created_at DESC`,
      args: [],
    });
    for (const row of r.rows) {
      const repo = String(row["repo"]);
      if (!critRisksMap.has(repo)) critRisksMap.set(repo, []);
      const arr = critRisksMap.get(repo)!;
      if (arr.length < 2) arr.push({ id: String(row["id"]), content: String(row["content"]).slice(0, 150), symbol: row["symbol"] != null ? String(row["symbol"]) : null });
    }
  } catch { /* ok */ }

  try {
    const r = await sessionsDb.execute({
      sql: `SELECT id, repo, content FROM deferred_work WHERE status='open' AND deprecated_by IS NULL ORDER BY created_at DESC`,
      args: [],
    });
    for (const row of r.rows) {
      const repo = String(row["repo"]);
      if (!openDeferredMap.has(repo)) openDeferredMap.set(repo, []);
      const arr = openDeferredMap.get(repo)!;
      if (arr.length < 3) arr.push({ id: String(row["id"]), content: String(row["content"]).slice(0, 150) });
    }
  } catch { /* ok */ }

  for (const m of manifests) {
    const repoPath   = m.repo;
    const name       = repoName(repoPath);
    const synced_at  = m.synced_at || null;
    const decisions  = decisionsMap.get(repoPath) ?? 0;
    const risks      = risksMap.get(repoPath) ?? 0;
    const deferred   = deferredMap.get(repoPath) ?? 0;
    const confirmed  = confirmedMap.get(repoPath) ?? 0;
    const pending    = allPendingByRepo.get(repoPath) ?? 0;
    const total      = decisions + risks + deferred;
    const sessCount  = sessionsCountMap.get(repoPath) ?? 0;
    const stuck      = stuckMap.get(repoPath) ?? 0;

    // Lore quality
    const dConf = dConfidence.get(repoPath) ?? {};
    const rConf = rConfidence.get(repoPath) ?? {};
    const dfConf = dfConfidence.get(repoPath) ?? {};
    const sumConf = (key: string) => (dConf[key] ?? 0) + (rConf[key] ?? 0) + (dfConf[key] ?? 0);
    const loreQuality = computeLoreQuality(
      sumConf("confirmed"), sumConf("extracted"), sumConf("inferred"), sumConf("contested"),
    );

    const structural = await getStructuralInfo(repoPath);
    const git = existsSync(repoPath) ? getGitInfo(repoPath) : { branch: null, dirty: false, last_commit: null, last_commit_relative: null };
    const sparkline = await getSessionSparkline(repoPath);
    const lastSess = lastSessionMap.get(repoPath) ?? { ended_at: null, summary: null };
    const lastSessionAge = lastSess.ended_at ? now - lastSess.ended_at : null;

    const steps = computeSetupSteps(repoPath, total, structural, sessCount, confirmed);
    const completedSteps = steps.filter((s) => s.complete).length;

    const status = computeStatus(synced_at, structural, { decisions, risks, deferred_open: deferred, confirmed, pending_review: pending, total }, sessCount, stuck, completedSteps, lastSessionAge);

    const advisor = advisorMap.get(repoPath) ?? { gap_score: 0, priority_gaps: 0, quick_wins: 0 };

    repoSummaries.push({
      name,
      path: repoPath,
      portfolio: m.portfolio,
      status,
      setup_steps: steps,
      git,
      records: { decisions, risks, deferred_open: deferred, confirmed, pending_review: pending, total },
      lore_quality:   loreQuality,
      structural,
      top_decisions:  topDecisionsMap.get(repoPath)  ?? [],
      critical_risks: critRisksMap.get(repoPath)     ?? [],
      open_deferred:  openDeferredMap.get(repoPath)  ?? [],
      last_session:   { ended_at: lastSess.ended_at, summary: lastSess.summary },
      session_sparkline: sparkline,
      sessions_total: sessCount,
      advisor,
      cross_repo: {
        exports_to:   crossExportsMap.get(repoPath) ?? [],
        imports_from: crossImportsMap.get(repoPath) ?? [],
      },
      synced_at,
    });
  }

  // ── 3b. Deduplicate repos by name (prefer absolute path, then more records) ─
  const _seenNames = new Map<string, RepoSummary>();
  for (const repo of repoSummaries) {
    const existing = _seenNames.get(repo.name);
    if (!existing) { _seenNames.set(repo.name, repo); continue; }
    const existingAbsolute = existing.path.startsWith("/");
    const repoAbsolute     = repo.path.startsWith("/");
    if (!existingAbsolute && repoAbsolute) { _seenNames.set(repo.name, repo); continue; }
    if (existingAbsolute && !repoAbsolute) continue;
    if (repo.records.total > existing.records.total) _seenNames.set(repo.name, repo);
  }
  const dedupedRepos = [..._seenNames.values()];

  // ── 4. Portfolios ─────────────────────────────────────────────────────────
  const portfolioMap = new Map<string, string[]>();
  for (const repo of dedupedRepos) {
    const p = repo.portfolio || "default";
    if (!portfolioMap.has(p)) portfolioMap.set(p, []);
    portfolioMap.get(p)!.push(repo.name);
  }
  const portfolios: PortfolioSummary[] = [];
  for (const [name, repos] of portfolioMap) {
    portfolios.push({ name, repos, repo_count: repos.length });
  }

  const standalone = dedupedRepos
    .filter((r) => r.portfolio === "default")
    .map((r) => r.name);

  // ── 5. Totals ─────────────────────────────────────────────────────────────
  const totals = {
    decisions:      dedupedRepos.reduce((s, r) => s + r.records.decisions, 0),
    risks:          dedupedRepos.reduce((s, r) => s + r.records.risks, 0),
    deferred:       dedupedRepos.reduce((s, r) => s + r.records.deferred_open, 0),
    sessions:       dedupedRepos.reduce((s, r) => s + r.sessions_total, 0),
    pending_review: dedupedRepos.reduce((s, r) => s + r.records.pending_review, 0),
  };

  // ── 6. System section ────────────────────────────────────────────────────
  const mcpStats = getMcpStats();
  const turso = getTursoStatus();
  const pm2   = getPm2Stats();

  let dbSessionsCount = 0;
  let dbRegistryCount = 0;
  let dbPersonalCount = 0;
  const dbSessions = { ok: false, row_count: 0 };
  const dbRegistry = { ok: false, row_count: 0 };
  const dbPersonal = { ok: false, row_count: 0 };

  try {
    const r = await sessionsDb.execute({ sql: "SELECT COUNT(*) as n FROM sessions", args: [] });
    dbSessionsCount = Number(r.rows[0]?.["n"] ?? 0);
    dbSessions.ok = true;
    dbSessions.row_count = dbSessionsCount;
  } catch { /* ok */ }
  try {
    const r = await registryDb.execute({ sql: "SELECT COUNT(*) as n FROM repo_manifests", args: [] });
    dbRegistryCount = Number(r.rows[0]?.["n"] ?? 0);
    dbRegistry.ok = true;
    dbRegistry.row_count = dbRegistryCount;
  } catch { /* ok */ }
  try {
    const { personalDb } = await import("../sqlite/db.js");
    const r = await personalDb.execute({ sql: "SELECT COUNT(*) as n FROM personal_records", args: [] });
    dbPersonalCount = Number(r.rows[0]?.["n"] ?? 0);
    dbPersonal.ok = true;
    dbPersonal.row_count = dbPersonalCount;
  } catch { /* ok */ }

  let sessionsCompressed = 0;
  try {
    const r = await sessionsDb.execute({
      sql: "SELECT COUNT(*) as n FROM sessions WHERE summary IS NOT NULL AND summary != ''",
      args: [],
    });
    sessionsCompressed = Number(r.rows[0]?.["n"] ?? 0);
  } catch { /* ok */ }

  // Binary check
  const binaryPath = process.execPath ?? null;
  const binaryExists = binaryPath ? existsSync(binaryPath) : false;

  // Review queue
  const reviewByRepo: SystemSummary["review_queue"]["by_repo"] = [];
  try {
    const r = await sessionsDb.execute({
      sql: `SELECT repo, COUNT(*) as c, MIN(created_at) as oldest FROM decisions WHERE confidence='extracted' AND deprecated_by IS NULL GROUP BY repo`,
      args: [],
    });
    for (const row of r.rows) {
      const oldest = row["oldest"] != null ? Number(row["oldest"]) : null;
      reviewByRepo.push({
        repo:            String(row["repo"]),
        pending:         Number(row["c"] ?? 0),
        oldest_age_days: oldest ? Math.floor((now - oldest) / MS_PER_DAY) : null,
      });
    }
  } catch { /* ok */ }

  const versionCheck = await checkVersion();

  const system: SystemSummary = {
    version: "1.0.0",
    worker: {
      running:        true,   // if we're here, worker is up
      port:           PORT,
      uptime_seconds: Math.floor((now - WORKER_START) / 1000),
      mode:           turso.connected ? "team" : "solo",
    },
    mcp: {
      tool_count:   mcpStats.toolCount,
      total_calls:  mcpStats.totalCalls,
      last_call_at: mcpStats.lastCallAt,
      calls_today:  mcpStats.callsToday,
    },
    databases: {
      sessions: dbSessions,
      registry: dbRegistry,
      personal: dbPersonal,
    },
    ai_compression: {
      api_key_set:         !!process.env["ANTHROPIC_API_KEY"],
      sessions_compressed: sessionsCompressed,
    },
    turso: {
      connected: turso.connected,
      sync_url:  turso.syncUrl,
    },
    pm2,
    environment: {
      CLAUDE_LORE_PORT:       process.env["CLAUDE_LORE_PORT"]       ? "set" : "not_set",
      CLAUDE_LORE_TURSO_URL:  process.env["CLAUDE_LORE_TURSO_URL"]  ? "set" : "not_set",
      CLAUDE_LORE_AUTH_TOKEN: process.env["CLAUDE_LORE_AUTH_TOKEN"] ? "set" : "not_set",
      ANTHROPIC_API_KEY:      process.env["ANTHROPIC_API_KEY"]      ? "set" : "not_set",
    },
    update_check: versionCheck,
    binary: {
      path:   binaryPath,
      exists: binaryExists,
    },
    review_queue: {
      total_pending: reviewByRepo.reduce((s, r) => s + r.pending, 0),
      by_repo:       reviewByRepo,
    },
  };

  return {
    generated_at:  now,
    repos:         dedupedRepos,
    portfolios,
    standalone,
    totals,
    activity_feed: activityFeed,
    system,
  };
}
