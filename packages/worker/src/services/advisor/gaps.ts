import { existsSync } from "fs";
import { join, isAbsolute, resolve } from "path";
import { getStructuralClient } from "../structural/db-cache.js";
import { sessionsDb } from "../sqlite/db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GapType =
  | "missing_adr"
  | "orphaned_record"
  | "unconfirmed_risk"
  | "stale_deferred"
  | "undocumented_symbol"
  | "missing_skill"
  | "undocumented_hierarchy";

export interface KnowledgeGap {
  type: GapType;
  description: string;
  symbol?: string;
  record_id?: string;
  score: number;       // contribution to total_gap_score
  age_days?: number;
}

export interface GapAdvisory {
  repo: string;
  generated_at: number;
  priority_gaps: KnowledgeGap[];   // score >= 10
  quick_wins: KnowledgeGap[];      // score < 10 — easy to address
  total_gap_score: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function ageDays(created_at: number): number {
  return Math.floor((Date.now() - created_at) / MS_PER_DAY);
}

async function highCallerSymbols(cwd: string): Promise<string[]> {
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) return [];
  const structuralPath = join(cwd, ".codegraph", "structural.db");
  if (!existsSync(structuralPath)) return [];
  const db = getStructuralClient(structuralPath)!;
  try {
    const res = await db.execute({
      sql: `SELECT callee FROM call_graph GROUP BY callee HAVING COUNT(*) >= 5`,
      args: [],
    });
    return res.rows.map((r) => String(r["callee"]));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export async function analyseKnowledgeGaps(
  repo: string,
  cwd: string,
): Promise<GapAdvisory> {
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) {
    throw new Error("cwd must be an absolute, non-traversal path");
  }

  const now = Date.now();
  const gaps: KnowledgeGap[] = [];

  // 1. missing_adr — high-caller symbols (5+) with no confirmed decision
  const highCallers = await highCallerSymbols(cwd);
  for (const sym of highCallers) {
    const res = await sessionsDb.execute({
      sql: `SELECT COUNT(*) as c FROM decisions
            WHERE repo = ? AND symbol = ? AND confidence = 'confirmed'`,
      args: [repo, sym],
    });
    if (Number(res.rows[0]["c"] ?? 0) === 0) {
      gaps.push({
        type: "missing_adr",
        description: `Symbol \`${sym}\` has 5+ callers but no confirmed decision documenting its contract.`,
        symbol: sym,
        score: 15,
      });
    }
  }

  // 2. orphaned_record — anchor_status = 'orphaned'
  for (const table of ["decisions", "deferred_work", "risks"] as const) {
    const res = await sessionsDb.execute({
      sql: `SELECT id, symbol, content, created_at FROM ${table}
            WHERE repo = ? AND anchor_status = 'orphaned'`,
      args: [repo],
    });
    for (const row of res.rows) {
      const r = row as Record<string, unknown>;
      gaps.push({
        type: "orphaned_record",
        description: `Orphaned ${table.replace("_", " ")} record: "${String(r["content"]).slice(0, 80)}..."`,
        symbol: r["symbol"] != null ? String(r["symbol"]) : undefined,
        record_id: String(r["id"]),
        score: 8,
        age_days: ageDays(Number(r["created_at"] ?? 0)),
      });
    }
  }

  // 3. unconfirmed_risk — risks with confidence = 'extracted' or 'inferred' older than 7 days
  const sevenDaysAgo = now - 7 * MS_PER_DAY;
  const riskRes = await sessionsDb.execute({
    sql: `SELECT id, symbol, content, confidence, created_at FROM risks
          WHERE repo = ? AND confidence IN ('extracted', 'inferred') AND created_at < ?`,
    args: [repo, sevenDaysAgo],
  });
  for (const row of riskRes.rows) {
    const r = row as Record<string, unknown>;
    const age = ageDays(Number(r["created_at"] ?? 0));
    gaps.push({
      type: "unconfirmed_risk",
      description: `Unreviewed risk (${String(r["confidence"])}): "${String(r["content"]).slice(0, 80)}..."`,
      symbol: r["symbol"] != null ? String(r["symbol"]) : undefined,
      record_id: String(r["id"]),
      score: age > 30 ? 12 : 7,
      age_days: age,
    });
  }

  // 4. stale_deferred — open deferred work older than 14 days with no blocked_by
  const fourteenDaysAgo = now - 14 * MS_PER_DAY;
  const deferredRes = await sessionsDb.execute({
    sql: `SELECT id, symbol, content, created_at FROM deferred_work
          WHERE repo = ? AND status = 'open'
            AND (blocked_by IS NULL OR blocked_by = '')
            AND created_at < ?`,
    args: [repo, fourteenDaysAgo],
  });
  for (const row of deferredRes.rows) {
    const r = row as Record<string, unknown>;
    const age = ageDays(Number(r["created_at"] ?? 0));
    gaps.push({
      type: "stale_deferred",
      description: `Deferred work untouched for ${age} days: "${String(r["content"]).slice(0, 80)}..."`,
      symbol: r["symbol"] != null ? String(r["symbol"]) : undefined,
      record_id: String(r["id"]),
      score: age > 30 ? 10 : 5,
      age_days: age,
    });
  }

  // 5. undocumented_symbol — high-caller symbols with no decisions at all (any confidence)
  for (const sym of highCallers) {
    const res = await sessionsDb.execute({
      sql: `SELECT COUNT(*) as c FROM decisions WHERE repo = ? AND symbol = ?`,
      args: [repo, sym],
    });
    if (Number(res.rows[0]["c"] ?? 0) === 0) {
      // Already captured in missing_adr if it had callers — avoid double-count
      const already = gaps.find(
        (g) => g.type === "missing_adr" && g.symbol === sym,
      );
      if (!already) {
        gaps.push({
          type: "undocumented_symbol",
          description: `Symbol \`${sym}\` has 5+ callers and zero knowledge records.`,
          symbol: sym,
          score: 10,
        });
      }
    }
  }

  // 6. missing_skill — symbols appearing in 5+ distinct sessions with no skill named after them
  const skillRes = await sessionsDb.execute({
    sql: `SELECT skill_name FROM skill_manifest WHERE repo = ? OR repo = 'global'`,
    args: [repo],
  });
  const skillNames = new Set(
    skillRes.rows.map((r) => String((r as Record<string, unknown>)["skill_name"]).toLowerCase()),
  );

  // Find symbols appearing in many sessions
  const sessionSymbolRes = await sessionsDb.execute({
    sql: `SELECT d.symbol, COUNT(DISTINCT d.session_id) as session_count
          FROM decisions d
          WHERE d.repo = ? AND d.symbol IS NOT NULL
          GROUP BY d.symbol
          HAVING session_count >= 5`,
    args: [repo],
  });
  for (const row of sessionSymbolRes.rows) {
    const r = row as Record<string, unknown>;
    const sym = String(r["symbol"]);
    // Skill is considered covering this symbol if any skill name includes the symbol name
    const covered = Array.from(skillNames).some((name) =>
      name.includes(sym.toLowerCase()) || sym.toLowerCase().includes(name),
    );
    if (!covered) {
      gaps.push({
        type: "missing_skill",
        description: `Symbol \`${sym}\` appears in ${String(r["session_count"])}+ sessions but no skill covers it.`,
        symbol: sym,
        score: 6,
      });
    }
  }

  // 7. undocumented_hierarchy — decisions with no edges to other decisions or risks
  const allDecisions = await sessionsDb.execute({
    sql: `SELECT id, content, symbol FROM decisions WHERE repo = ?`,
    args: [repo],
  });
  if (allDecisions.rows.length > 1) {
    // Build a simple adjacency check: decisions that share a symbol with another record
    const symbolCount = new Map<string, number>();
    for (const row of allDecisions.rows) {
      const sym = String((row as Record<string, unknown>)["symbol"] ?? "");
      if (sym) symbolCount.set(sym, (symbolCount.get(sym) ?? 0) + 1);
    }
    for (const row of allDecisions.rows) {
      const r = row as Record<string, unknown>;
      const sym = String(r["symbol"] ?? "");
      // Isolated: no symbol, or symbol appears only once (no other record shares it)
      if (!sym || (symbolCount.get(sym) ?? 0) <= 1) {
        gaps.push({
          type: "undocumented_hierarchy",
          description: `Decision isolated in graph (no shared symbols): "${String(r["content"]).slice(0, 60)}..." — run \`claude-lore graph decisions\` to visualise. Does it constrain or relate to any other decision?`,
          symbol: sym || undefined,
          record_id: String(r["id"]),
          score: 4,
        });
      }
    }
  }

  // Partition and score
  const total_gap_score = gaps.reduce((sum, g) => sum + g.score, 0);
  const priority_gaps = gaps
    .filter((g) => g.score >= 10)
    .sort((a, b) => b.score - a.score);
  const quick_wins = gaps
    .filter((g) => g.score < 10)
    .sort((a, b) => b.score - a.score);

  return {
    repo,
    generated_at: now,
    priority_gaps,
    quick_wins,
    total_gap_score,
  };
}
