import { execSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join, isAbsolute, resolve } from "path";
import { sessionsDb, registryDb } from "../sqlite/db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportedRecord {
  id: string;
  table: string;
  symbol: string | null;
  content: string | null;  // null for redacted tier
  confidence: string | null;
  exported_tier: string;
  anchor_status: string;
  created_at: number;
}

export interface RepoManifest {
  repo: string;
  version: string;       // git commit SHA
  exported_decisions: ExportedRecord[];
  exported_deferred: ExportedRecord[];
  exported_risks: ExportedRecord[];
  synced_at: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getGitSha(cwd: string): string {
  try {
    return execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Tiers that cross repo boundaries (anything that isn't private or personal) */
function isExported(tier: string): boolean {
  return tier !== "private" && tier !== "personal";
}

function redactRow(row: Record<string, unknown>, table: string): ExportedRecord {
  const tier = String(row["exported_tier"] ?? "private");
  if (tier === "redacted") {
    return {
      id: String(row["id"]),
      table,
      symbol: null,
      content: null,
      confidence: null,
      exported_tier: tier,
      anchor_status: String(row["anchor_status"] ?? "healthy"),
      created_at: Number(row["created_at"]),
    };
  }
  return {
    id: String(row["id"]),
    table,
    symbol: row["symbol"] != null ? String(row["symbol"]) : null,
    content: String(row["content"] ?? ""),
    confidence: String(row["confidence"] ?? "extracted"),
    exported_tier: tier,
    anchor_status: String(row["anchor_status"] ?? "healthy"),
    created_at: Number(row["created_at"]),
  };
}

async function queryExported(
  table: string,
  repo: string,
): Promise<ExportedRecord[]> {
  const res = await sessionsDb.execute({
    sql: `SELECT id, symbol, content, confidence, exported_tier, anchor_status, created_at
          FROM ${table}
          WHERE repo = ? AND exported_tier NOT IN ('private', 'personal')`,
    args: [repo],
  });
  return res.rows
    .map((r) => r as Record<string, unknown>)
    .filter((r) => isExported(String(r["exported_tier"] ?? "private")))
    .map((r) => redactRow(r, table));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function generateManifest(
  repo: string,
  cwd: string,
): Promise<RepoManifest> {
  const [decisions, deferred, risks] = await Promise.all([
    queryExported("decisions", repo),
    queryExported("deferred_work", repo),
    queryExported("risks", repo),
  ]);

  return {
    repo,
    version: getGitSha(cwd),
    exported_decisions: decisions,
    exported_deferred: deferred,
    exported_risks: risks,
    synced_at: Date.now(),
  };
}

export function writeManifest(cwd: string, manifest: RepoManifest): void {
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) {
    throw new Error("cwd must be an absolute, non-traversal path");
  }
  const dir = join(cwd, ".codegraph");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "exports.manifest"),
    JSON.stringify(manifest, null, 2),
  );
}

export async function syncToRegistry(
  manifest: RepoManifest,
  portfolioName = "default",
): Promise<void> {
  await registryDb.execute({
    sql: `INSERT OR REPLACE INTO repo_manifests (repo, manifest, synced_at, portfolio) VALUES (?, ?, ?, ?)`,
    args: [manifest.repo, JSON.stringify(manifest), manifest.synced_at, portfolioName],
  });

  // Index every exported symbol into the cross-repo index
  const allRecords = [
    ...manifest.exported_decisions,
    ...manifest.exported_deferred,
    ...manifest.exported_risks,
  ];
  for (const record of allRecords) {
    if (!record.symbol) continue;
    await registryDb.execute({
      sql: `INSERT OR REPLACE INTO cross_repo_index (symbol, repo, tier, signature, indexed_at, portfolio)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        record.symbol,
        manifest.repo,
        record.exported_tier,
        record.content?.slice(0, 200) ?? null,
        manifest.synced_at,
        portfolioName,
      ],
    });
  }
}
