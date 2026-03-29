import { createInterface } from "readline";

const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function assertWorkerRunning(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error();
  } catch {
    console.error("Worker not running. Start it first:\n  claude-lore worker start");
    process.exit(1);
  }
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}/api/portfolio${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { error: string }).error ?? "Request failed");
  }
  return data;
}

async function get(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE_URL}/api/portfolio${path}${qs ? `?${qs}` : ""}`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { error: string }).error ?? "Request failed");
  }
  return data;
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function repoBasename(repoPath: string): string {
  return repoPath.split("/").pop() ?? repoPath;
}

function formatAge(syncedAt: number | null): string {
  if (!syncedAt) return "not yet synced";
  const diff = Math.floor((Date.now() - syncedAt) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── create ───────────────────────────────────────────────────────────────────

export async function portfolioCreate(name: string, opts: { description?: string }): Promise<void> {
  await assertWorkerRunning();
  try {
    await post("/create", { name, description: opts.description });
    console.log(`✓ Created portfolio "${name}"`);
    console.log(`  Add repos: claude-lore portfolio add ${name} <repo-path>`);
  } catch (err) {
    console.error(`✗ ${String(err)}`);
    process.exit(1);
  }
}

// ─── add ─────────────────────────────────────────────────────────────────────

export async function portfolioAdd(name: string, repoPath: string): Promise<void> {
  await assertWorkerRunning();
  try {
    const data = (await post("/add", { name, repo_path: repoPath })) as {
      symbols_synced: number;
    };
    console.log(`✓ Added ${repoBasename(repoPath)} to portfolio "${name}"`);
    console.log(`⟳ Syncing manifest...`);
    console.log(`✓ Synced — ${data.symbols_synced} exported symbol(s) registered`);
  } catch (err) {
    console.error(`✗ ${String(err)}`);
    process.exit(1);
  }
}

// ─── remove ──────────────────────────────────────────────────────────────────

export async function portfolioRemove(name: string, repoPath: string): Promise<void> {
  await assertWorkerRunning();
  try {
    await post("/remove", { name, repo_path: repoPath });
    console.log(`✓ Removed ${repoBasename(repoPath)} from portfolio "${name}"`);
  } catch (err) {
    console.error(`✗ ${String(err)}`);
    process.exit(1);
  }
}

// ─── list ─────────────────────────────────────────────────────────────────────

export async function portfolioList(): Promise<void> {
  await assertWorkerRunning();
  const data = (await get("/list")) as {
    portfolios: Array<{
      name: string;
      description?: string;
      repos: string[];
      repo_statuses: Array<{ repo: string; synced_at: number | null }>;
    }>;
    standalone: string[];
  };

  if (data.portfolios.length === 0 && data.standalone.length === 0) {
    console.log("No portfolios yet. Create one:\n  claude-lore portfolio create <name>");
    return;
  }

  console.log("Portfolios:\n");

  for (const p of data.portfolios) {
    const desc = p.description ? ` — ${p.description}` : "";
    console.log(`${p.name} (${p.repos.length} repo${p.repos.length !== 1 ? "s" : ""})${desc}`);

    for (const status of p.repo_statuses) {
      const synced = status.synced_at !== null;
      const icon = synced ? "✓" : "✗";
      const label = status.repo.padEnd(50);
      const age = formatAge(status.synced_at);
      console.log(`  ${icon} ${label} — ${age}`);
    }
    console.log();
  }

  if (data.standalone.length > 0) {
    console.log(`standalone (not in any portfolio):`);
    for (const repo of data.standalone) {
      console.log(`  ${repo}`);
    }
  }
}

// ─── sync ─────────────────────────────────────────────────────────────────────

export async function portfolioSync(name: string): Promise<void> {
  await assertWorkerRunning();
  try {
    const data = (await post("/sync", { name })) as {
      results: Array<{ repo: string; symbols: number; error?: string }>;
    };

    for (const r of data.results) {
      if (r.error) {
        console.log(`⟳ Syncing ${repoBasename(r.repo)}... ✗ ${r.error}`);
      } else {
        console.log(
          `⟳ Syncing ${repoBasename(r.repo)}... ✓ ${r.symbols} symbol${r.symbols !== 1 ? "s" : ""}`,
        );
      }
    }
    console.log(`✓ Portfolio "${name}" synced`);
  } catch (err) {
    console.error(`✗ ${String(err)}`);
    process.exit(1);
  }
}

// ─── status ───────────────────────────────────────────────────────────────────

export async function portfolioStatus(name: string): Promise<void> {
  await assertWorkerRunning();
  try {
    const data = (await get("/status", { name })) as {
      name: string;
      repos: number;
      symbols: number;
      cross_repo_links: number;
      relationships: Array<{ symbol: string; repos: string[] }>;
      shared_risks: { critical: number; high: number; medium: number; low: number };
      open_deferred: number;
    };

    console.log(`Portfolio: ${data.name}\n`);
    console.log(
      `Repos: ${data.repos} · Symbols: ${data.symbols} · Cross-repo links: ${data.cross_repo_links}\n`,
    );

    if (data.relationships.length > 0) {
      console.log("Cross-repo relationships:");
      for (const rel of data.relationships) {
        const repos = rel.repos.map(repoBasename).join(" → ");
        console.log(`  ${repos}   (${rel.symbol})`);
      }
      console.log();
    }

    const { critical, high, medium, low } = data.shared_risks;
    const riskParts: string[] = [];
    if (critical > 0) riskParts.push(`${critical} critical`);
    if (high > 0) riskParts.push(`${high} high`);
    if (medium > 0) riskParts.push(`${medium} medium`);
    if (low > 0) riskParts.push(`${low} low`);
    if (riskParts.length > 0) {
      console.log(`Shared risks: ${riskParts.join(", ")}`);
    }

    console.log(`Open deferred across portfolio: ${data.open_deferred} item${data.open_deferred !== 1 ? "s" : ""}`);
  } catch (err) {
    console.error(`✗ ${String(err)}`);
    process.exit(1);
  }
}

// ─── init (interactive) ───────────────────────────────────────────────────────

export async function portfolioInit(name: string): Promise<void> {
  await assertWorkerRunning();

  const repo = process.cwd();
  console.log(`Creating portfolio "${name}"`);

  try {
    await post("/create", { name });
  } catch (err) {
    const msg = String(err);
    if (!msg.includes("already exists")) {
      console.error(`✗ ${msg}`);
      process.exit(1);
    }
    console.log(`  (portfolio "${name}" already exists — adding to it)`);
  }

  process.stdout.write(`Adding current repo: ${repo} `);
  const addResult = (await post("/add", { name, repo_path: repo })) as {
    symbols_synced: number;
  };
  console.log(`✓ (${addResult.symbols_synced} symbols)`);

  console.log("\nLink other repos? Enter paths one per line (empty line to finish):");
  const extra: string[] = [];
  while (true) {
    const line = await prompt("> ");
    if (!line) break;
    extra.push(line);
  }

  for (const repoPath of extra) {
    try {
      const r = (await post("/add", { name, repo_path: repoPath })) as {
        symbols_synced: number;
      };
      console.log(`✓ Added ${repoBasename(repoPath)} (${r.symbols_synced} symbols)`);
    } catch (err) {
      console.log(`✗ ${repoBasename(repoPath)}: ${String(err)}`);
    }
  }

  const total = 1 + extra.length;
  console.log(`\n✓ Portfolio "${name}" created with ${total} repo${total !== 1 ? "s" : ""}`);
  console.log(`  Run: claude-lore portfolio sync ${name}`);
}
