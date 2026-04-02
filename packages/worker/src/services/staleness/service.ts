import { existsSync } from "fs";
import { join, isAbsolute, resolve } from "path";
import { getStructuralClient } from "../structural/db-cache.js";
import { sessionsDb } from "../sqlite/db.js";

// ---------------------------------------------------------------------------
// Levenshtein distance (pure TS, no deps)
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AnchorStatus = "healthy" | "re-anchored" | "orphaned" | "unknown";

export interface StalenessEntry {
  id: string;
  table: string;
  symbol: string;
  original_symbol?: string;
  anchor_status: AnchorStatus;
  content: string;
}

export interface StalenessReport {
  repo: string;
  structural_db_present: boolean;
  counts: Record<AnchorStatus, number>;
  orphaned: StalenessEntry[];
  re_anchored: StalenessEntry[];
  checked_at: number;
}

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

export async function checkStaleness(
  repo: string,
  cwd: string,
): Promise<StalenessReport> {
  // Reject non-absolute or traversal paths before opening any file from user-supplied cwd
  const safeCwd = isAbsolute(cwd) && resolve(cwd) === cwd ? cwd : "";
  const structuralPath = safeCwd ? join(safeCwd, ".codegraph", "structural.db") : "";
  const hasStructural = safeCwd ? existsSync(structuralPath) : false;

  const tables = ["decisions", "deferred_work", "risks"] as const;
  const counts: Record<AnchorStatus, number> = {
    healthy: 0,
    "re-anchored": 0,
    orphaned: 0,
    unknown: 0,
  };
  const orphaned: StalenessEntry[] = [];
  const re_anchored: StalenessEntry[] = [];

  if (!hasStructural) {
    // Can't check — count everything as unknown
    for (const table of tables) {
      const res = await sessionsDb.execute({
        sql: `SELECT COUNT(*) as c FROM ${table} WHERE repo = ? AND symbol IS NOT NULL`,
        args: [repo],
      });
      counts.unknown += Number(res.rows[0]["c"] ?? 0);
    }
    return {
      repo,
      structural_db_present: false,
      counts,
      orphaned: [],
      re_anchored: [],
      checked_at: Date.now(),
    };
  }

  const structDb = getStructuralClient(structuralPath)!;

  // Load all known symbols from structural.db
  let allSymbols: string[] = [];
  try {
    const symRes = await structDb.execute({
      sql: `SELECT name FROM symbols`,
      args: [],
    });
    allSymbols = symRes.rows.map((r) => String(r["name"]));
  } catch {
    // symbols table not present — treat as unknown
    for (const table of tables) {
      const res = await sessionsDb.execute({
        sql: `SELECT COUNT(*) as c FROM ${table} WHERE repo = ? AND symbol IS NOT NULL`,
        args: [repo],
      });
      counts.unknown += Number(res.rows[0]["c"] ?? 0);
    }
    return {
      repo,
      structural_db_present: true,
      counts,
      orphaned: [],
      re_anchored: [],
      checked_at: Date.now(),
    };
  }

  const symbolSet = new Set(allSymbols);

  for (const table of tables) {
    const res = await sessionsDb.execute({
      sql: `SELECT id, symbol, content, anchor_status FROM ${table}
            WHERE repo = ? AND symbol IS NOT NULL`,
      args: [repo],
    });

    for (const row of res.rows) {
      const r = row as Record<string, unknown>;
      const symbol = String(r["symbol"]);
      const id = String(r["id"]);
      const content = String(r["content"] ?? "");

      if (symbolSet.has(symbol)) {
        // healthy — ensure status is set correctly
        if (String(r["anchor_status"]) !== "healthy") {
          await sessionsDb.execute({
            sql: `UPDATE ${table} SET anchor_status = 'healthy' WHERE id = ?`,
            args: [id],
          });
        }
        counts.healthy++;
        continue;
      }

      // Try fuzzy match (Levenshtein < 3)
      let bestMatch: string | null = null;
      let bestDist = Infinity;
      for (const candidate of allSymbols) {
        const d = levenshtein(symbol, candidate);
        if (d < 3 && d < bestDist) {
          bestDist = d;
          bestMatch = candidate;
        }
      }

      if (bestMatch) {
        await sessionsDb.execute({
          sql: `UPDATE ${table}
                SET anchor_status = 're-anchored', symbol = ?, original_symbol = ?
                WHERE id = ?`,
          args: [bestMatch, symbol, id],
        });
        counts["re-anchored"]++;
        re_anchored.push({
          id,
          table,
          symbol: bestMatch,
          original_symbol: symbol,
          anchor_status: "re-anchored",
          content,
        });
      } else {
        await sessionsDb.execute({
          sql: `UPDATE ${table} SET anchor_status = 'orphaned' WHERE id = ?`,
          args: [id],
        });
        counts.orphaned++;
        orphaned.push({ id, table, symbol, anchor_status: "orphaned", content });
      }
    }
  }

  return {
    repo,
    structural_db_present: true,
    counts,
    orphaned,
    re_anchored,
    checked_at: Date.now(),
  };
}

export async function getStalenessReport(repo: string): Promise<StalenessReport> {
  const counts: Record<AnchorStatus, number> = {
    healthy: 0,
    "re-anchored": 0,
    orphaned: 0,
    unknown: 0,
  };
  const orphaned: StalenessEntry[] = [];
  const re_anchored: StalenessEntry[] = [];

  for (const table of ["decisions", "deferred_work", "risks"] as const) {
    const res = await sessionsDb.execute({
      sql: `SELECT id, symbol, content, anchor_status, original_symbol
            FROM ${table} WHERE repo = ? AND symbol IS NOT NULL`,
      args: [repo],
    });
    for (const row of res.rows) {
      const r = row as Record<string, unknown>;
      const status = String(r["anchor_status"] ?? "healthy") as AnchorStatus;
      counts[status] = (counts[status] ?? 0) + 1;
      if (status === "orphaned") {
        orphaned.push({
          id: String(r["id"]),
          table,
          symbol: String(r["symbol"]),
          anchor_status: "orphaned",
          content: String(r["content"] ?? ""),
        });
      } else if (status === "re-anchored") {
        re_anchored.push({
          id: String(r["id"]),
          table,
          symbol: String(r["symbol"]),
          original_symbol: r["original_symbol"] != null ? String(r["original_symbol"]) : undefined,
          anchor_status: "re-anchored",
          content: String(r["content"] ?? ""),
        });
      }
    }
  }

  return {
    repo,
    structural_db_present: false, // report mode — we don't re-check
    counts,
    orphaned,
    re_anchored,
    checked_at: Date.now(),
  };
}
