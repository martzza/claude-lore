import { existsSync, readFileSync, writeFileSync, statSync, readdirSync, chmodSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";

const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";
const BASE_URL = `http://127.0.0.1:${PORT}`;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface CheckResult {
  label:      string;
  status:     "pass" | "warn" | "fail";
  detail:     string;
  fix?:       string;
  autoFix?:   boolean;   // can --fix handle this automatically?
}

interface DoctorReport {
  summary: { total: number; passed: number; warnings: number; errors: number };
  checks:  Array<{ name: string; status: string; message: string; fix?: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".codegraph")) || existsSync(join(dir, "package.json"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function findClaudeLoreRoot(): string {
  let dir = process.cwd();
  if (existsSync(join(dir, "packages", "cli"))) return dir;
  const home = homedir();
  for (const c of [
    join(home, "Documents", "claude-lore"),
    join(home, "projects", "claude-lore"),
    join(home, "code", "claude-lore"),
  ]) {
    if (existsSync(join(c, "packages", "cli"))) return c;
  }
  return dir;
}

function getWorkerStartTime(): number | null {
  try {
    const raw = spawnSync("pm2", ["jlist"], { timeout: 4000, encoding: "utf8" }).stdout;
    const procs = JSON.parse(raw) as Array<Record<string, unknown>>;
    for (const p of procs) {
      if (String(p["name"] ?? "").includes("claude-lore")) {
        const env = p["pm2_env"] as Record<string, unknown> | undefined;
        const t = env?.["pm_uptime"] ?? env?.["created_at"];
        if (typeof t === "number") return t;
      }
    }
  } catch {}
  return null;
}

function newestMtime(dir: string): number {
  let newest = 0;
  if (!existsSync(dir)) return newest;
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules") walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const mt = statSync(full).mtimeMs;
        if (mt > newest) newest = mt;
      }
    }
  };
  walk(dir);
  return newest;
}

// Extract .js file paths from hook command strings
function hookScriptPaths(settingsPath: string): string[] {
  if (!existsSync(settingsPath)) return [];
  try {
    const s = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const hooks = s["hooks"] as Record<string, unknown[]> | undefined;
    if (!hooks) return [];
    const paths: string[] = [];
    for (const handlers of Object.values(hooks)) {
      for (const handler of handlers ?? []) {
        const h = handler as Record<string, unknown>;
        const hookList = h["hooks"] as Array<Record<string, unknown>> | undefined;
        for (const hk of hookList ?? []) {
          const cmd = String(hk["command"] ?? "");
          // command looks like: "node /path/to/context-hook.js"
          const match = cmd.match(/(\S+\.js)(\s|$)/);
          if (match) paths.push(match[1]!);
        }
      }
    }
    return [...new Set(paths)];
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Check groups
// ─────────────────────────────────────────────────────────────────────────────

function checkRuntime(): CheckResult[] {
  const results: CheckResult[] = [];
  const loreRoot = findClaudeLoreRoot();

  // Bun version
  const bunResult = spawnSync("bun", ["--version"], { encoding: "utf8", timeout: 3000 });
  if (bunResult.error || bunResult.status !== 0) {
    results.push({
      label: "Bun installed",
      status: "fail",
      detail: "bun not found in PATH",
      fix: "curl -fsSL https://bun.sh/install | bash",
    });
  } else {
    const ver = bunResult.stdout.trim().replace(/^v/, "");
    const [major] = ver.split(".").map(Number);
    const ok = (major ?? 0) >= 1;
    results.push({
      label: `Bun ${ver}`,
      status: ok ? "pass" : "fail",
      detail: ok ? `minimum 1.0.0 satisfied` : `${ver} is below minimum 1.0.0`,
      fix: ok ? undefined : "curl -fsSL https://bun.sh/install | bash",
    });
  }

  // Port ownership
  const lsofResult = spawnSync("lsof", ["-ti", `:${PORT}`], { encoding: "utf8", timeout: 3000 });
  const pid = lsofResult.stdout.trim().split("\n")[0]?.trim();
  if (pid) {
    const psResult = spawnSync("ps", ["-p", pid, "-o", "comm="], { encoding: "utf8", timeout: 2000 });
    const procName = psResult.stdout.trim();
    const ours = /bun|claude|node/i.test(procName);
    results.push({
      label: `Port ${PORT} ownership`,
      status: ours ? "pass" : "fail",
      detail: ours
        ? `owned by claude-lore worker (PID ${pid})`
        : `port in use by '${procName}' (PID ${pid}) — not claude-lore`,
      fix: ours ? undefined : `Stop the other process or set CLAUDE_LORE_PORT to a different port`,
    });
  }

  // claude-lore root accessible
  const rootOk = existsSync(join(loreRoot, "packages", "worker", "mcp.ts"));
  results.push({
    label: "claude-lore source root",
    status: rootOk ? "pass" : "fail",
    detail: rootOk ? loreRoot : `Source not found — checked ${loreRoot}`,
    fix: rootOk ? undefined : "Clone the repo and re-run claude-lore init",
  });

  return results;
}

async function checkWorker(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const loreRoot = findClaudeLoreRoot();

  // Worker health
  let workerOk = false;
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    workerOk = res.ok;
  } catch {}

  if (!workerOk) {
    results.push({ label: "Worker running", status: "fail", detail: `Not responding on port ${PORT}`, fix: "claude-lore worker start", autoFix: false });
    return results;
  }
  results.push({ label: "Worker running", status: "pass", detail: `http://127.0.0.1:${PORT}` });

  // MCP tool count via tools/list
  try {
    const mcpTs = join(loreRoot, "packages", "worker", "mcp.ts");
    const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const r = spawnSync("bun", ["run", mcpTs], {
      input: req, encoding: "utf8", timeout: 8000,
      env: { ...process.env, CLAUDE_LORE_PORT: PORT },
    });
    const line = r.stdout.split("\n").find((l) => l.includes('"result"'));
    if (line) {
      const data = JSON.parse(line) as { result?: { tools?: unknown[] } };
      const count = data.result?.tools?.length ?? 0;
      results.push({ label: `MCP tools registered`, status: count >= 20 ? "pass" : "warn", detail: `${count} tools`, fix: count < 20 ? "claude-lore worker restart" : undefined });
    }
  } catch {}

  // MCP version vs source
  try {
    const mcpTs = join(loreRoot, "packages", "worker", "mcp.ts");
    const pkgPath = join(loreRoot, "packages", "worker", "package.json");
    const initReq = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "doctor", version: "1.0" } } });
    const r = spawnSync("bun", ["run", mcpTs], {
      input: initReq, encoding: "utf8", timeout: 8000,
      env: { ...process.env, CLAUDE_LORE_PORT: PORT },
    });
    const line = r.stdout.split("\n").find((l) => l.includes('"serverInfo"'));
    const runningVersion = line
      ? (JSON.parse(line) as { result?: { serverInfo?: { version?: string } } }).result?.serverInfo?.version
      : undefined;
    const sourceVersion = existsSync(pkgPath)
      ? (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version
      : undefined;

    if (runningVersion && sourceVersion) {
      const match = runningVersion === sourceVersion;
      results.push({
        label: "MCP server version",
        status: match ? "pass" : "warn",
        detail: match
          ? `${runningVersion} matches source`
          : `Running: ${runningVersion} · Source: ${sourceVersion} — restart to update`,
        fix: match ? undefined : "claude-lore worker restart",
        autoFix: true,
      });
    }
  } catch {}

  // Worker source staleness via PM2
  const workerStartMs = getWorkerStartTime();
  if (workerStartMs !== null) {
    const workerSrc = join(loreRoot, "packages", "worker", "src");
    const mcpTs = join(loreRoot, "packages", "worker", "mcp.ts");
    const srcNewest = Math.max(newestMtime(workerSrc), existsSync(mcpTs) ? statSync(mcpTs).mtimeMs : 0);
    const stale = srcNewest > workerStartMs;
    const startedAt = new Date(workerStartMs).toLocaleTimeString();
    results.push({
      label: "Worker source up to date",
      status: stale ? "warn" : "pass",
      detail: stale
        ? `Source changed after worker started (${startedAt}) — restart to pick up changes`
        : `Running on latest source (started ${startedAt})`,
      fix: stale ? "pm2 restart claude-lore-worker" : undefined,
      autoFix: true,
    });
  }

  return results;
}

async function checkSessions(repoRoot: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // Schema + stuck sessions via /api/doctor
  try {
    const res = await fetch(`${BASE_URL}/api/doctor`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = (await res.json()) as {
        schema: Record<string, { columns: string[]; missing: string[] }>;
        stuck_sessions: number;
      };

      // Schema check
      const allMissing: string[] = [];
      for (const [table, info] of Object.entries(data.schema)) {
        if (info.missing.length > 0) allMissing.push(`${table}: ${info.missing.join(", ")}`);
      }
      results.push({
        label: "DB schema current",
        status: allMissing.length === 0 ? "pass" : "fail",
        detail: allMissing.length === 0
          ? "All columns present"
          : `Missing columns — ${allMissing.join(" | ")}`,
        fix: allMissing.length > 0 ? "claude-lore worker restart  (initDb runs migrations)" : undefined,
        autoFix: true,
      });

      // Stuck sessions
      const stuck = data.stuck_sessions;
      results.push({
        label: "No stuck sessions",
        status: stuck === 0 ? "pass" : "warn",
        detail: stuck === 0
          ? "No active sessions older than 1 hour"
          : `${stuck} session${stuck !== 1 ? "s" : ""} stuck in active state — Stop hook may not have fired`,
        fix: stuck > 0 ? "claude-lore doctor --fix" : undefined,
        autoFix: stuck > 0,
      });
    }
  } catch {}

  // Bootstrap records
  try {
    const res = await fetch(
      `${BASE_URL}/api/records/counts?repo=${encodeURIComponent(repoRoot)}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (res.ok) {
      const d = (await res.json()) as Record<string, unknown>;
      const dec = Number(d["decisions"] ?? 0);
      const risk = Number(d["risks"] ?? 0);
      const hasRecords = dec > 0 || risk > 0;
      results.push({
        label: "Bootstrap records present",
        status: hasRecords ? "pass" : "warn",
        detail: hasRecords
          ? `${dec} decision${dec !== 1 ? "s" : ""}, ${risk} risk${risk !== 1 ? "s" : ""}`
          : "No records found — agent will start with no prior context",
        fix: hasRecords ? undefined : "claude-lore bootstrap",
      });
    }
  } catch {}

  // Portfolio manifest freshness
  try {
    const res = await fetch(
      `${BASE_URL}/api/portfolio/current?repo=${encodeURIComponent(repoRoot)}`,
      { signal: AbortSignal.timeout(2000) },
    );
    if (res.ok) {
      const d = (await res.json()) as Record<string, unknown>;
      const portfolioName = d["portfolio"] ? String(d["portfolio"]) : null;
      if (portfolioName) {
        const syncedAt = d["synced_at"] ? Number(d["synced_at"]) : null;
        const ageSeconds = syncedAt ? Math.floor(Date.now() / 1000) - syncedAt : null;
        const stale = ageSeconds !== null && ageSeconds > 86400;
        const ageHours = ageSeconds !== null ? Math.round(ageSeconds / 3600) : null;
        results.push({
          label: `Portfolio manifest (${portfolioName})`,
          status: stale ? "warn" : "pass",
          detail: stale
            ? `Last synced ${ageHours}h ago — cross-repo queries may be stale`
            : ageHours !== null ? `Synced ${ageHours}h ago` : `In portfolio: ${portfolioName}`,
          fix: stale ? `claude-lore portfolio sync ${portfolioName}` : undefined,
          autoFix: true,
        });
      }
    }
  } catch {}

  return results;
}

async function checkApiKeys(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const loreRoot = findClaudeLoreRoot();

  // ANTHROPIC_API_KEY — validate with models list endpoint
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    results.push({
      label: "ANTHROPIC_API_KEY",
      status: "warn",
      detail: "Not set — AI compression will be skipped at every Stop hook",
      fix: "export ANTHROPIC_API_KEY=sk-ant-...  (add to shell profile)",
    });
  } else {
    try {
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401) {
        results.push({
          label: "ANTHROPIC_API_KEY",
          status: "fail",
          detail: "Set but invalid (401) — compression will fail silently",
          fix: "Check key at https://console.anthropic.com/settings/keys",
        });
      } else if (res.ok) {
        results.push({ label: "ANTHROPIC_API_KEY", status: "pass", detail: "Valid and reachable" });
      } else {
        results.push({
          label: "ANTHROPIC_API_KEY",
          status: "warn",
          detail: `Anthropic API returned ${res.status} — check connectivity`,
        });
      }
    } catch {
      results.push({
        label: "ANTHROPIC_API_KEY",
        status: "warn",
        detail: "Set but Anthropic API unreachable — check network connectivity",
      });
    }
  }

  // Turso (team mode)
  const globalConfigPath = join(homedir(), ".codegraph", "config.json");
  let tursoUrl: string | null = null;
  let tursoToken: string | null = null;
  if (existsSync(globalConfigPath)) {
    try {
      const cfg = JSON.parse(readFileSync(globalConfigPath, "utf8")) as Record<string, unknown>;
      if (cfg["mode"] === "team") {
        tursoUrl = typeof cfg["turso_url"] === "string" ? cfg["turso_url"] : null;
        tursoToken = typeof cfg["turso_auth_token"] === "string" ? cfg["turso_auth_token"] : null;
      }
    } catch {}
  }

  if (tursoUrl) {
    if (!tursoToken) {
      results.push({
        label: "Turso auth token",
        status: "fail",
        detail: "turso_url set but turso_auth_token missing — sync will fail",
        fix: "claude-lore mode set team  (re-enter credentials)",
      });
    } else {
      // Test connectivity via a minimal HTTP request to the Turso REST API
      try {
        const dbName = tursoUrl.replace("libsql://", "").split(".")[0] ?? "";
        const org = tursoUrl.replace("libsql://", "").split(".").slice(1).join(".").split(".")[0] ?? "";
        // Simple check: just try to reach the Turso base URL
        const pingUrl = tursoUrl.replace("libsql://", "https://");
        const res = await fetch(`${pingUrl}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${tursoToken}` },
          signal: AbortSignal.timeout(5000),
        });
        // Any non-network-error response means connectivity works
        results.push({
          label: "Turso connectivity",
          status: "pass",
          detail: `Connected to ${tursoUrl}`,
        });
      } catch {
        results.push({
          label: "Turso connectivity",
          status: "fail",
          detail: `Cannot reach ${tursoUrl} — check URL and token`,
          fix: "claude-lore mode set team  (re-enter credentials)",
        });
      }
    }
  } else {
    results.push({
      label: "Turso (team sync)",
      status: "pass",
      detail: "Solo mode — not configured (this is fine)",
    });
  }

  // MCP registration
  const globalSettings = join(homedir(), ".claude", "settings.json");
  let mcpEntry: Record<string, unknown> | null = null;
  if (existsSync(globalSettings)) {
    try {
      const s = JSON.parse(readFileSync(globalSettings, "utf8")) as Record<string, unknown>;
      const mcp = s["mcpServers"] as Record<string, unknown> | undefined;
      if (typeof mcp === "object" && mcp !== null && "claude-lore" in mcp) {
        mcpEntry = mcp["claude-lore"] as Record<string, unknown>;
      }
    } catch {}
  }
  results.push({
    label: "MCP server registered (Claude Code)",
    status: mcpEntry ? "pass" : "fail",
    detail: mcpEntry
      ? "claude-lore entry in ~/.claude/settings.json"
      : "/lore MCP tool calls will silently fail",
    fix: mcpEntry ? undefined : "claude-lore init",
    autoFix: true,
  });

  if (mcpEntry) {
    const args = mcpEntry["args"] as string[] | undefined;
    const mcpPath = Array.isArray(args) ? args.find((a) => a.endsWith(".ts")) : undefined;
    const pathOk = mcpPath ? existsSync(mcpPath) : false;
    results.push({
      label: "MCP server path valid",
      status: pathOk ? "pass" : "fail",
      detail: pathOk ? mcpPath! : mcpPath ? `File not found: ${mcpPath}` : "No .ts path in args",
      fix: pathOk ? undefined : "claude-lore init",
      autoFix: true,
    });
  }

  return results;
}

function checkHooks(repoRoot: string): CheckResult[] {
  const results: CheckResult[] = [];
  const settingsPath = join(repoRoot, ".claude", "settings.json");

  if (!existsSync(settingsPath)) {
    results.push({ label: ".claude/settings.json", status: "fail", detail: `Not found: ${settingsPath}`, fix: "claude-lore init" });
    return results;
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    results.push({ label: ".claude/settings.json", status: "fail", detail: "Invalid JSON", fix: "claude-lore init" });
    return results;
  }

  // Hook events registered
  const hooks = (settings["hooks"] ?? {}) as Record<string, unknown[]>;
  const events = [
    { event: "SessionStart",     label: "SessionStart hook" },
    { event: "UserPromptSubmit", label: "UserPromptSubmit hook" },
    { event: "PostToolUse",      label: "PostToolUse hook" },
    { event: "Stop",             label: "Stop hook" },
    { event: "SessionEnd",       label: "SessionEnd hook" },
  ];
  let allRegistered = true;
  for (const { event, label } of events) {
    const ok = Array.isArray(hooks[event]) && hooks[event].length > 0;
    if (!ok) allRegistered = false;
    results.push({
      label,
      status: ok ? "pass" : "warn",
      detail: ok ? `registered` : `missing from ${settingsPath}`,
      fix: ok ? undefined : "claude-lore init",
      autoFix: !ok,
    });
  }

  // Hook script paths exist
  const scriptPaths = hookScriptPaths(settingsPath);
  const missing = scriptPaths.filter((p) => !existsSync(p));
  results.push({
    label: "Hook script paths exist",
    status: missing.length === 0 ? "pass" : "fail",
    detail: missing.length === 0
      ? `${scriptPaths.length} script${scriptPaths.length !== 1 ? "s" : ""} found on disk`
      : `Missing: ${missing.map((p) => p.split("/").slice(-1)[0]).join(", ")}`,
    fix: missing.length > 0 ? "claude-lore init  (updates hook paths)" : undefined,
    autoFix: missing.length > 0,
  });

  // Hook scripts executable
  const nonExecutable = scriptPaths.filter((p) => {
    if (!existsSync(p)) return false;
    try {
      const mode = statSync(p).mode;
      return (mode & 0o111) === 0;
    } catch { return false; }
  });
  if (nonExecutable.length > 0) {
    results.push({
      label: "Hook scripts executable",
      status: "warn",
      detail: `Not executable: ${nonExecutable.map((p) => p.split("/").slice(-1)[0]).join(", ")}`,
      fix: `chmod +x ${nonExecutable.join(" ")}`,
      autoFix: true,
    });
  } else if (scriptPaths.length > 0) {
    results.push({ label: "Hook scripts executable", status: "pass", detail: "All scripts have execute permission" });
  }

  return results;
}

async function checkStructural(repoRoot: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const dbPath = join(repoRoot, ".codegraph", "structural.db");

  if (!existsSync(dbPath)) {
    results.push({
      label:  "Structural index",
      status: "warn",
      detail: "structural.db not found — codegraph_* MCP tools will be unavailable",
      fix:    "claude-lore index",
    });
    return results;
  }

  // Query stats from the HTTP endpoint if worker is running, otherwise skip detail
  try {
    const statsRes = await fetch(
      `${BASE_URL}/api/structural/stats?cwd=${encodeURIComponent(repoRoot)}&repo=${encodeURIComponent(repoRoot)}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (statsRes.ok) {
      const stats = (await statsRes.json()) as Record<string, unknown>;
      if ((stats as { indexed?: boolean })["indexed"] === false) {
        results.push({
          label:  "Structural index",
          status: "warn",
          detail: "structural.db exists but has no index_meta — run claude-lore index",
          fix:    "claude-lore index",
        });
        return results;
      }

      const symbolCount = Number(stats["symbol_count"] ?? 0);
      const edgeCount   = Number(stats["edge_count"]   ?? 0);
      const indexedAt   = Number(stats["indexed_at"]   ?? 0);
      const ageSeconds  = Math.floor(Date.now() / 1000) - indexedAt;
      const ageDays     = Math.round(ageSeconds / 86400);

      if (symbolCount === 0) {
        results.push({
          label:  "Structural index",
          status: "warn",
          detail: "Index exists but has no symbols — run claude-lore index --force",
          fix:    "claude-lore index --force",
        });
        return results;
      }

      if (ageSeconds > 7 * 86400) {
        results.push({
          label:  "Structural index",
          status: "warn",
          detail: `Index is ${ageDays} days old — consider refreshing (${symbolCount} symbols, ${edgeCount} edges)`,
          fix:    "claude-lore index",
        });
        return results;
      }

      // Check staleness via git SHA
      try {
        const staleRes = await fetch(
          `${BASE_URL}/api/structural/stale?cwd=${encodeURIComponent(repoRoot)}&repo=${encodeURIComponent(repoRoot)}`,
          { signal: AbortSignal.timeout(3000) },
        );
        if (staleRes.ok) {
          const staleData = (await staleRes.json()) as { stale?: boolean };
          if (staleData.stale) {
            results.push({
              label:  "Structural index",
              status: "warn",
              detail: `Index commit SHA differs from HEAD — ${symbolCount} symbols, ${edgeCount} edges, last indexed ${ageDays}d ago`,
              fix:    "claude-lore index",
            });
            return results;
          }
        }
      } catch {}

      results.push({
        label:  "Structural index",
        status: "pass",
        detail: `${symbolCount} symbols · ${edgeCount} edges · indexed ${ageDays === 0 ? "today" : `${ageDays}d ago`}`,
      });
    }
  } catch {
    // Worker not running — just check file presence
    results.push({
      label:  "Structural index",
      status: "pass",
      detail: `structural.db present (start worker for full stats)`,
    });
  }

  return results;
}

function checkCommands(): CheckResult[] {
  const results: CheckResult[] = [];
  const loreMdPath = join(homedir(), ".claude", "commands", "lore.md");
  const loreRoot = findClaudeLoreRoot();

  if (!existsSync(loreMdPath)) {
    results.push({
      label: "~/.claude/commands/lore.md",
      status: "fail",
      detail: "/lore command not installed",
      fix: "claude-lore init",
      autoFix: true,
    });
    return results;
  }

  const content = readFileSync(loreMdPath, "utf8");
  const required = ["reasoning_get", "advisor_summary", "allowed-tools"];
  const missing = required.filter((s) => !content.includes(s));

  results.push({
    label: "~/.claude/commands/lore.md",
    status: missing.length === 0 ? "pass" : "fail",
    detail: missing.length === 0
      ? "Installed and valid"
      : `Missing required content: ${missing.join(", ")} — file may be outdated`,
    fix: missing.length > 0 ? "claude-lore init  (reinstalls lore.md)" : undefined,
    autoFix: missing.length > 0,
  });

  return results;
}

function checkCli(): CheckResult[] {
  const results: CheckResult[] = [];
  const binPath = join(homedir(), ".bun", "bin", "claude-lore");

  if (!existsSync(binPath)) {
    results.push({ label: "CLI binary", status: "fail", detail: `Not found: ${binPath}`, fix: "pnpm run build:cli" });
    return results;
  }

  const loreRoot = findClaudeLoreRoot();
  const binMtime = statSync(binPath).mtimeMs;
  const cliSrc = join(loreRoot, "packages", "cli", "src");
  const srcNewest = newestMtime(cliSrc);

  const stale = srcNewest > binMtime;
  results.push({
    label: "CLI binary up to date",
    status: stale ? "warn" : "pass",
    detail: stale ? "Source changed since last build" : binPath,
    fix: stale ? "claude-lore update" : undefined,
    autoFix: stale,
  });

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// --fix automation
// ─────────────────────────────────────────────────────────────────────────────

async function applyFixes(checks: CheckResult[], repoRoot: string): Promise<void> {
  const { execSync } = await import("child_process");
  let anyFixed = false;

  // MCP registration
  if (checks.find((c) => c.label === "MCP server registered (Claude Code)" && c.status !== "pass")) {
    const loreRoot = findClaudeLoreRoot();
    const mcpTs = join(loreRoot, "packages", "worker", "mcp.ts");
    const globalSettings = join(homedir(), ".claude", "settings.json");
    let cfg: Record<string, unknown> = {};
    if (existsSync(globalSettings)) try { cfg = JSON.parse(readFileSync(globalSettings, "utf8")) as Record<string, unknown>; } catch {}
    cfg["mcpServers"] = {
      ...((cfg["mcpServers"] as Record<string, unknown>) ?? {}),
      "claude-lore": { command: "bun", args: ["run", mcpTs], env: { CLAUDE_LORE_PORT: "37778" } },
    };
    writeFileSync(globalSettings, JSON.stringify(cfg, null, 2));
    console.log("  ✓ Registered MCP server in ~/.claude/settings.json (restart Claude Code)");
    anyFixed = true;
  }

  // lore.md missing/outdated
  if (checks.find((c) => c.label === "~/.claude/commands/lore.md" && c.status !== "pass")) {
    const loreRoot = findClaudeLoreRoot();
    const src = join(loreRoot, "plugins", "claude-lore", "commands", "lore.md");
    const dst = join(homedir(), ".claude", "commands", "lore.md");
    if (existsSync(src)) {
      const { mkdirSync, copyFileSync } = await import("fs");
      mkdirSync(join(homedir(), ".claude", "commands"), { recursive: true });
      copyFileSync(src, dst);
      console.log("  ✓ Reinstalled ~/.claude/commands/lore.md");
      anyFixed = true;
    }
  }

  // Hook scripts executable
  const nonExec = checks.find((c) => c.label === "Hook scripts executable" && c.status !== "pass");
  if (nonExec?.fix) {
    const paths = nonExec.fix.replace("chmod +x ", "").split(" ");
    for (const p of paths) {
      try { chmodSync(p, 0o755); } catch {}
    }
    console.log(`  ✓ chmod +x applied to ${paths.length} hook script${paths.length !== 1 ? "s" : ""}`);
    anyFixed = true;
  }

  // Stuck sessions
  if (checks.find((c) => c.label === "No stuck sessions" && c.status !== "pass")) {
    try {
      const res = await fetch(`${BASE_URL}/api/doctor/fix-stuck`, { method: "POST", signal: AbortSignal.timeout(5000) });
      if (res.ok) { console.log("  ✓ Stuck sessions marked as completed"); anyFixed = true; }
    } catch {}
  }

  // Worker restart (stale source, schema migration, MCP version mismatch)
  const needsRestart = checks.some((c) =>
    c.autoFix && c.status !== "pass" && (
      c.label === "Worker source up to date" ||
      c.label === "DB schema current" ||
      c.label === "MCP server version"
    ),
  );
  if (needsRestart) {
    try {
      execSync("pm2 restart claude-lore-worker", { stdio: "inherit" });
      console.log("  ✓ Worker restarted");
      anyFixed = true;
    } catch {
      console.log("  ✗ Worker restart failed — run: claude-lore worker restart");
    }
  }

  // Portfolio sync
  const staleManifest = checks.find((c) => c.label.startsWith("Portfolio manifest") && c.status !== "pass");
  if (staleManifest?.fix) {
    try {
      execSync(staleManifest.fix, { stdio: "inherit" });
      console.log("  ✓ Portfolio synced");
      anyFixed = true;
    } catch {}
  }

  // CLI rebuild
  if (checks.find((c) => c.label === "CLI binary up to date" && c.status !== "pass")) {
    try {
      execSync("claude-lore update", { stdio: "inherit" });
      anyFixed = true;
    } catch { console.log("  ✗ CLI rebuild failed — run: claude-lore update"); }
  }

  if (!anyFixed) console.log("  Nothing to fix automatically.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderChecks(sections: Array<{ label: string; checks: CheckResult[] }>): void {
  for (const section of sections) {
    if (section.checks.length === 0) continue;
    console.log(`\n${section.label}`);
    for (const c of section.checks) {
      const icon = c.status === "pass" ? "✓" : c.status === "warn" ? "⚠" : "✗";
      if (c.status === "pass") {
        console.log(`${icon} ${c.label}`);
        console.log(`  ${c.detail}`);
      } else {
        console.log(`${icon} ${c.label}`);
        console.log(`  ${c.detail}`);
        if (c.fix) console.log(`  Fix: ${c.fix}`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function runOnce(repoRoot: string, opts: { fix?: boolean; json?: boolean }): Promise<{
  allChecks: CheckResult[];
  sections: Array<{ label: string; checks: CheckResult[] }>;
  passed: number; warned: number; failed: number;
}> {
  const [workerChecks, sessionChecks, apiKeyChecks, structuralChecks] = await Promise.all([
    checkWorker(),
    checkSessions(repoRoot),
    checkApiKeys(),
    checkStructural(repoRoot),
  ]);
  const runtimeChecks = checkRuntime();
  const hookChecks = checkHooks(repoRoot);
  const commandChecks = checkCommands();
  const cliChecks = checkCli();

  const sections = [
    { label: "RUNTIME",                       checks: runtimeChecks },
    { label: "WORKER",                        checks: workerChecks },
    { label: "SESSIONS",                      checks: sessionChecks },
    { label: "STRUCTURAL",                    checks: structuralChecks },
    { label: "API KEYS",                      checks: apiKeyChecks },
    { label: `HOOKS — ${repoRoot}`,           checks: hookChecks },
    { label: "COMMANDS",                      checks: commandChecks },
    { label: "CLI",                           checks: cliChecks },
  ];

  const allChecks = sections.flatMap((s) => s.checks);
  const passed = allChecks.filter((c) => c.status === "pass").length;
  const warned = allChecks.filter((c) => c.status === "warn").length;
  const failed = allChecks.filter((c) => c.status === "fail").length;

  return { allChecks, sections, passed, warned, failed };
}

export async function runDoctor(opts: { fix?: boolean; json?: boolean; watch?: boolean }): Promise<void> {
  const repoRoot = findRepoRoot();
  const repoName = repoRoot.split("/").pop() ?? repoRoot;
  const DIVIDER = "═".repeat(40);

  if (opts.watch) {
    // ── Watch mode ──────────────────────────────────────────────────────────
    console.log(`claude-lore doctor --watch  (${repoName})`);
    console.log("Checking every 30s. Press Ctrl+C to stop.\n");

    let lastSummary = "";
    const run = async () => {
      const { allChecks, passed, warned, failed } = await runOnce(repoRoot, opts);
      const ts = new Date().toLocaleTimeString();
      const problems = allChecks.filter((c) => c.status !== "pass");
      const summary = `${passed}p ${warned}w ${failed}e`;

      if (problems.length === 0) {
        if (summary !== lastSummary) console.log(`[${ts}] All checks passing (${passed}/${allChecks.length})`);
      } else {
        console.log(`[${ts}] ${warned} warning${warned !== 1 ? "s" : ""}, ${failed} error${failed !== 1 ? "s" : ""}`);
        for (const c of problems) {
          const icon = c.status === "warn" ? "⚠" : "✗";
          console.log(`         ${icon} ${c.label} — ${c.detail}`);
          if (c.fix) console.log(`           Fix: ${c.fix}`);
        }
      }
      lastSummary = summary;
    };

    await run();
    setInterval(run, 30_000);
    return; // stays alive
  }

  // ── Single run ─────────────────────────────────────────────────────────────
  const { allChecks, sections, passed, warned, failed } = await runOnce(repoRoot, opts);

  if (opts.json) {
    const report: DoctorReport = {
      summary: { total: allChecks.length, passed, warnings: warned, errors: failed },
      checks: allChecks.map((c) => ({ name: c.label, status: c.status, message: c.detail, fix: c.fix })),
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(failed > 0 ? 1 : 0);
    return;
  }

  console.log(`\nclaude-lore system check — ${repoName}`);
  console.log(DIVIDER);
  renderChecks(sections);

  const fixable = allChecks.filter((c) => c.status !== "pass" && c.autoFix);
  const manual  = allChecks.filter((c) => c.status !== "pass" && !c.autoFix && c.fix);

  console.log(`\n${DIVIDER}`);
  console.log(`${passed} passed · ${warned} warning${warned !== 1 ? "s" : ""} · ${failed} error${failed !== 1 ? "s" : ""}`);

  if (opts.fix && (warned > 0 || failed > 0)) {
    console.log("\nApplying fixes...");
    await applyFixes(allChecks, repoRoot);
  } else {
    if (fixable.length > 0) console.log(`\nRun claude-lore doctor --fix to apply ${fixable.length} automatic fix${fixable.length !== 1 ? "es" : ""}`);
    if (manual.length > 0) {
      console.log("Manual fixes required:");
      for (const c of manual) console.log(`  ${c.fix}`);
    }
  }

  console.log();
  process.exit(failed > 0 ? 1 : 0);
}
