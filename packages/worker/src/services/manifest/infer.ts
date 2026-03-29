import { sessionsDb, registryDb } from "../sqlite/db.js";

// ---------------------------------------------------------------------------
// Tier inference rules (priority order — first match wins)
// ---------------------------------------------------------------------------

const REDACTED_RE = /auth|token|secret|key|password|pii|private/i;
const PUBLIC_RE = /index\.(ts|js)|api\.(ts|js)|routes?\.(ts|js)/i;

export type InferredTier = "redacted" | "public" | "shared" | "private";

export interface TierInference {
  symbol: string;
  file_path: string | null;
  current_tier: string;
  suggested_tier: InferredTier;
  reason: string;
  is_override: boolean; // current !== suggested
}

export function inferTier(
  symbolName: string,
  filePath: string,
  importedByRepos: string[],
): { tier: InferredTier; reason: string } {
  if (REDACTED_RE.test(symbolName) || REDACTED_RE.test(filePath)) {
    return {
      tier: "redacted",
      reason: `Symbol or file path matches sensitive pattern: /${REDACTED_RE.source}/i`,
    };
  }
  if (PUBLIC_RE.test(filePath)) {
    return {
      tier: "public",
      reason: `File path matches public surface pattern: /${PUBLIC_RE.source}/i`,
    };
  }
  if (importedByRepos.length > 0) {
    return {
      tier: "shared",
      reason: `Symbol is indexed in ${importedByRepos.length} other repo(s): ${importedByRepos.slice(0, 3).join(", ")}`,
    };
  }
  return { tier: "private", reason: "No cross-repo usage detected; defaulting to private" };
}

// ---------------------------------------------------------------------------
// Batch inference for a repo
// ---------------------------------------------------------------------------

export async function inferAllTiers(
  repo: string,
  _cwd: string,
): Promise<TierInference[]> {
  // Get all records with a symbol for this repo
  const tables = ["decisions", "deferred_work", "risks"] as const;
  const allRecords: Array<{ id: string; symbol: string; exported_tier: string }> = [];

  for (const table of tables) {
    const res = await sessionsDb.execute({
      sql: `SELECT id, symbol, exported_tier FROM ${table}
            WHERE repo = ? AND symbol IS NOT NULL`,
      args: [repo],
    });
    for (const row of res.rows) {
      const r = row as Record<string, unknown>;
      if (r["symbol"]) {
        allRecords.push({
          id: String(r["id"]),
          symbol: String(r["symbol"]),
          exported_tier: String(r["exported_tier"] ?? "private"),
        });
      }
    }
  }

  // Build a set of symbols that appear in cross_repo_index from OTHER repos
  const crossRepoRes = await registryDb.execute({
    sql: `SELECT symbol, repo FROM cross_repo_index WHERE repo != ?`,
    args: [repo],
  });
  const crossRepoMap = new Map<string, string[]>();
  for (const row of crossRepoRes.rows) {
    const sym = String(row["symbol"]);
    const r = String(row["repo"]);
    const existing = crossRepoMap.get(sym) ?? [];
    existing.push(r);
    crossRepoMap.set(sym, existing);
  }

  // Deduplicate by symbol (show each symbol once)
  const seen = new Set<string>();
  const inferences: TierInference[] = [];

  for (const record of allRecords) {
    if (seen.has(record.symbol)) continue;
    seen.add(record.symbol);

    const importedByRepos = crossRepoMap.get(record.symbol) ?? [];
    const { tier, reason } = inferTier(record.symbol, "", importedByRepos);

    inferences.push({
      symbol: record.symbol,
      file_path: null,
      current_tier: record.exported_tier,
      suggested_tier: tier,
      reason,
      is_override: record.exported_tier !== tier,
    });
  }

  return inferences.sort((a, b) => Number(b.is_override) - Number(a.is_override));
}
