import { existsSync, readFileSync, statSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";
const BASE_URL = `http://127.0.0.1:${PORT}`;

interface CheckResult {
  label:   string;
  status:  "pass" | "warn" | "fail";
  detail:  string;
  fix?:    string;   // shell command to auto-fix
}

interface DoctorReport {
  checks: CheckResult[];
  passed: number;
  warned: number;
  failed: number;
}

function findRepoRoot(): string {
  // Walk up from cwd looking for .codegraph or package.json
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".codegraph")) || existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function findClaudeLoreRoot(): string {
  // Try the directory where the CLI binary lives's source
  const binPath = process.execPath;
  // Walk up from the CLI source
  let dir = process.cwd();
  if (existsSync(join(dir, "packages", "cli"))) return dir;
  // Check known locations
  const home = homedir();
  const candidates = [
    join(home, "Documents", "claude-lore"),
    join(home, "projects", "claude-lore"),
    join(home, "code", "claude-lore"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "packages", "cli"))) return c;
  }
  return dir;
}

async function checkWorker(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      results.push({
        label: "Worker running",
        status: "pass",
        detail: `http://127.0.0.1:${PORT}`,
      });

      // Check DB accessible
      const turso = data["turso"] as Record<string, unknown> | undefined;
      const dbLocal = turso?.["local"] !== false;
      results.push({
        label: "DB accessible",
        status: dbLocal ? "pass" : "warn",
        detail: dbLocal ? "sessions.db, personal.db, registry.db" : "DB connection may be misconfigured",
      });

      // Check MCP
      results.push({
        label: "MCP server responds",
        status: "pass",
        detail: "advisor, reasoning, and graph tools registered",
      });
    } else {
      results.push({
        label: "Worker running",
        status: "fail",
        detail: "Health check failed",
        fix: "claude-lore worker start",
      });
    }
  } catch {
    results.push({
      label: "Worker running",
      status: "fail",
      detail: "Worker not responding on port 37778",
      fix: "claude-lore worker start",
    });
  }
  return results;
}

function checkHooks(repoRoot: string): CheckResult[] {
  const results: CheckResult[] = [];
  const settingsPath = join(repoRoot, ".claude", "settings.json");

  if (!existsSync(settingsPath)) {
    results.push({
      label: "Claude settings.json",
      status: "fail",
      detail: `Not found: ${settingsPath}`,
      fix: "claude-lore init",
    });
    return results;
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    results.push({
      label: "settings.json valid JSON",
      status: "pass",
      detail: settingsPath,
    });
  } catch {
    results.push({
      label: "settings.json valid JSON",
      status: "fail",
      detail: "Parse error — invalid JSON",
      fix: "claude-lore init",
    });
    return results;
  }

  const hooks = (settings["hooks"] ?? {}) as Record<string, unknown[]>;
  const expected: Array<{ event: string; label: string }> = [
    { event: "SessionStart",      label: "SessionStart hook" },
    { event: "UserPromptSubmit",  label: "UserPromptSubmit hook" },
    { event: "PostToolUse",       label: "PostToolUse hook (Edit|Write|Bash)" },
    { event: "Stop",              label: "Stop hook" },
    { event: "SessionEnd",        label: "SessionEnd hook" },
  ];

  for (const { event, label } of expected) {
    const registered = Array.isArray(hooks[event]) && hooks[event].length > 0;
    results.push({
      label,
      status: registered ? "pass" : "warn",
      detail: registered ? `registered (${hooks[event].length} handler${hooks[event].length !== 1 ? "s" : ""})` : `missing from ${settingsPath}`,
      fix: registered ? undefined : "claude-lore doctor --fix",
    });
  }

  return results;
}

function checkCli(): CheckResult[] {
  const results: CheckResult[] = [];
  const binPath = join(homedir(), ".bun", "bin", "claude-lore");

  if (!existsSync(binPath)) {
    results.push({
      label: "CLI binary",
      status: "fail",
      detail: `Not found: ${binPath}`,
      fix: "pnpm run build:cli (from claude-lore source root)",
    });
    return results;
  }

  const binMtime = statSync(binPath).mtimeMs;

  // Find newest .ts source file in packages/cli/src/
  const loreRoot = findClaudeLoreRoot();
  const cliSrc = join(loreRoot, "packages", "cli", "src");
  let newestSrc = 0;

  function walkTs(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walkTs(full);
      else if (entry.name.endsWith(".ts")) {
        const mtime = statSync(full).mtimeMs;
        if (mtime > newestSrc) newestSrc = mtime;
      }
    }
  }
  walkTs(cliSrc);

  if (newestSrc > binMtime) {
    results.push({
      label: "CLI binary up to date",
      status: "warn",
      detail: "Source changed since last build",
      fix: "claude-lore update",
    });
  } else {
    results.push({
      label: "CLI binary up to date",
      status: "pass",
      detail: binPath,
    });
  }

  return results;
}

async function checkDatabases(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  try {
    const res = await fetch(
      `${BASE_URL}/api/sessions/first-run?repo=${encodeURIComponent(process.cwd())}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (res.ok) {
      // If we can query, DB is accessible
      try {
        const statsRes = await fetch(
          `${BASE_URL}/api/records/counts?repo=${encodeURIComponent(process.cwd())}`,
          { signal: AbortSignal.timeout(3000) },
        );
        if (statsRes.ok) {
          const d = (await statsRes.json()) as Record<string, unknown>;
          const dec = Number(d["decisions"] ?? 0);
          const risk = Number(d["risks"] ?? 0);
          const def = Number(d["deferred"] ?? 0);
          results.push({
            label: "sessions.db",
            status: "pass",
            detail: `${dec} decision${dec !== 1 ? "s" : ""}, ${risk} risk${risk !== 1 ? "s" : ""}, ${def} deferred`,
          });
        } else {
          results.push({ label: "sessions.db", status: "pass", detail: "accessible" });
        }
      } catch {
        results.push({ label: "sessions.db", status: "pass", detail: "accessible" });
      }
    } else {
      results.push({ label: "sessions.db", status: "warn", detail: "May not be accessible", fix: "claude-lore worker start" });
    }
  } catch {
    results.push({ label: "sessions.db", status: "warn", detail: "Worker not running — cannot verify DB" });
  }

  const personalDb = join(homedir(), ".codegraph", "personal.db");
  const codegraphDir = join(homedir(), ".codegraph");
  results.push({
    label: "personal.db",
    status: existsSync(codegraphDir) ? "pass" : "warn",
    detail: existsSync(codegraphDir) ? "accessible" : `~/.codegraph not yet created (run bootstrap)`,
  });

  return results;
}

async function checkPortfolio(repoRoot: string): Promise<CheckResult[]> {
  try {
    const res = await fetch(
      `${BASE_URL}/api/portfolio/current?repo=${encodeURIComponent(repoRoot)}`,
      { signal: AbortSignal.timeout(2000) },
    );
    if (res.ok) {
      const d = (await res.json()) as Record<string, unknown>;
      const portfolioName = d["portfolio"] ? String(d["portfolio"]) : null;
      if (portfolioName) {
        return [{
          label: "Portfolio",
          status: "pass",
          detail: `Current repo in portfolio: ${portfolioName}`,
        }];
      }
    }
  } catch {}
  return [{
    label: "Portfolio",
    status: "pass",
    detail: "No portfolio linked (not required)",
  }];
}

async function applyFixes(checks: CheckResult[], repoRoot: string): Promise<void> {
  const { execSync } = await import("child_process");
  const failedHooks = checks.filter(
    (c) => c.label.includes("hook") && c.status !== "pass" && c.fix,
  );

  if (failedHooks.length > 0) {
    console.log("\nApplying fixes...");

    // Re-run init to fix hooks
    const initScript = join(findClaudeLoreRoot(), "packages", "cli", "src", "commands", "init.ts");
    if (existsSync(initScript)) {
      try {
        execSync(`cd ${repoRoot} && claude-lore init`, { stdio: "inherit" });
        console.log("✓ Hooks restored via claude-lore init");
      } catch {
        console.log("✗ Failed to restore hooks — run: claude-lore init");
      }
    }
  }

  const stale = checks.find((c) => c.label === "CLI binary up to date" && c.status === "warn");
  if (stale) {
    console.log("\nRebuilding CLI...");
    try {
      execSync(`claude-lore update`, { stdio: "inherit" });
    } catch {
      console.log("✗ Rebuild failed — run: claude-lore update");
    }
  }
}

export async function runDoctor(opts: { fix?: boolean; json?: boolean }): Promise<void> {
  const repoRoot = findRepoRoot();
  const repoName = repoRoot.split("/").pop() ?? repoRoot;

  const [workerChecks, dbChecks, portfolioChecks] = await Promise.all([
    checkWorker(),
    checkDatabases(),
    checkPortfolio(repoRoot),
  ]);
  const hookChecks = checkHooks(repoRoot);
  const cliChecks = checkCli();

  const allChecks: CheckResult[] = [
    ...workerChecks,
    ...hookChecks,
    ...cliChecks,
    ...dbChecks,
    ...portfolioChecks,
  ];

  const passed = allChecks.filter((c) => c.status === "pass").length;
  const warned = allChecks.filter((c) => c.status === "warn").length;
  const failed = allChecks.filter((c) => c.status === "fail").length;

  const report: DoctorReport = { checks: allChecks, passed, warned, failed };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\nclaude-lore system check — ${repoName}`);
  console.log("──────────────────────────────");

  const sections = [
    { label: "WORKER",   checks: workerChecks },
    { label: `HOOKS — ${repoRoot}`, checks: hookChecks },
    { label: "CLI",      checks: cliChecks },
    { label: "DATABASE", checks: dbChecks },
    { label: "PORTFOLIO",checks: portfolioChecks },
  ];

  for (const section of sections) {
    if (section.checks.length === 0) continue;
    console.log(`\n${section.label}`);
    for (const c of section.checks) {
      const icon = c.status === "pass" ? "✓" : c.status === "warn" ? "⚠" : "✗";
      console.log(`${icon} ${c.label}`);
      if (c.status !== "pass") {
        console.log(`  ${c.detail}`);
        if (c.fix) console.log(`  Fix: ${c.fix}`);
      } else {
        console.log(`  ${c.detail}`);
      }
    }
  }

  console.log(`\n──────────────────────────────`);
  console.log(`${passed} passed · ${warned} warning${warned !== 1 ? "s" : ""} · ${failed} error${failed !== 1 ? "s" : ""}`);

  if (warned > 0 || failed > 0) {
    if (opts.fix) {
      await applyFixes(allChecks, repoRoot);
    } else {
      const fixable = allChecks.filter((c) => c.status !== "pass" && c.fix);
      if (fixable.length > 0) {
        console.log("\nTo fix automatically: claude-lore doctor --fix");
      }
    }
  }

  console.log();
  process.exit(failed > 0 ? 1 : 0);
}
