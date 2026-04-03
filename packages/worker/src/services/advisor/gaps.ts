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
  | "undocumented_hierarchy"
  | "zombie_deferred"
  | "supersession_conflict"
  | "unreviewed_template_records"
  | "unresolved_conflict";

export interface KnowledgeGap {
  type: GapType;
  description: string;
  symbol?: string;
  record_id?: string;
  record_ids?: string[];
  score: number;       // contribution to total_gap_score
  age_days?: number;
  capture_hint?: string;
  estimated_effort?: string;
  zombie_sessions?: number;
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
  // created_at stored as ms in some tables, as unix seconds in others
  // Values < 1e10 are unix seconds; values >= 1e10 are milliseconds
  const ms = created_at < 1e10 ? created_at * 1000 : created_at;
  return Math.floor((Date.now() - ms) / MS_PER_DAY);
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

/** Token Jaccard similarity for supersession conflict detection */
function tokenSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s.toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length >= 4),
    );
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  return intersection / (ta.size + tb.size - intersection);
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
        capture_hint: `Run: /lore log decision  OR  claude-lore advisor gaps`,
        estimated_effort: "minutes",
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
        capture_hint: `Run: claude-lore review`,
        estimated_effort: "minutes",
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
      capture_hint: `Run: claude-lore review`,
      estimated_effort: "minutes",
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
      capture_hint: `Run: claude-lore review`,
      estimated_effort: "minutes",
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
          capture_hint: `Run: /lore log decision`,
          estimated_effort: "minutes",
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
    const symbolCount = new Map<string, number>();
    for (const row of allDecisions.rows) {
      const sym = String((row as Record<string, unknown>)["symbol"] ?? "");
      if (sym) symbolCount.set(sym, (symbolCount.get(sym) ?? 0) + 1);
    }
    for (const row of allDecisions.rows) {
      const r = row as Record<string, unknown>;
      const sym = String(r["symbol"] ?? "");
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

  // 8. zombie_deferred — open deferred items whose anchor symbol was touched in ≥2 sessions
  const zombieRes = await sessionsDb.execute({
    sql: `SELECT id, symbol, content, created_at, blocked_by, touched_by_sessions
          FROM deferred_work
          WHERE repo = ?
            AND lifecycle_status = 'active'
            AND resolved_at IS NULL
            AND json_array_length(touched_by_sessions) >= 2
          ORDER BY json_array_length(touched_by_sessions) DESC
          LIMIT 10`,
    args: [repo],
  });

  for (const row of zombieRes.rows) {
    const r = row as Record<string, unknown>;
    let sessionCount = 0;
    try {
      sessionCount = (JSON.parse(String(r["touched_by_sessions"] ?? "[]")) as unknown[]).length;
    } catch {}
    const createdMs = Number(r["created_at"] ?? 0);
    const ageDaysVal = ageDays(createdMs);
    const content = String(r["content"] ?? "");

    gaps.push({
      type: "zombie_deferred",
      symbol: r["symbol"] != null ? String(r["symbol"]) : undefined,
      description:
        `Deferred item "${content.slice(0, 60)}" was created ${ageDaysVal} days ago and its ` +
        `anchor symbol was touched in ${sessionCount} sessions — was this completed?`,
      capture_hint: `Run: claude-lore review`,
      estimated_effort: "minutes",
      record_id: String(r["id"]),
      zombie_sessions: sessionCount,
      score: sessionCount >= 3 ? 12 : 8,
      age_days: ageDaysVal,
    });
  }

  // 9. supersession_conflict — active decisions on the same symbol without a supersedes link
  const activeDecRes = await sessionsDb.execute({
    sql: `SELECT id, symbol, content, confidence, created_at
          FROM decisions
          WHERE repo = ?
            AND lifecycle_status = 'active'
            AND supersedes IS NULL
            AND superseded_by IS NULL
          ORDER BY created_at DESC`,
    args: [repo],
  });

  const decRows = activeDecRes.rows as Record<string, unknown>[];
  const conflictPairs: Array<{ a: Record<string, unknown>; b: Record<string, unknown>; score: number }> = [];

  for (let i = 0; i < decRows.length; i++) {
    for (let j = i + 1; j < decRows.length; j++) {
      const a = decRows[i]!;
      const b = decRows[j]!;
      if (!a["symbol"] || !b["symbol"] || a["symbol"] !== b["symbol"]) continue;
      const sim = tokenSimilarity(String(a["content"] ?? ""), String(b["content"] ?? ""));
      if (sim > 0.35 && sim < 0.85) {
        conflictPairs.push({ a, b, score: sim });
      }
    }
  }

  for (const { a, b } of conflictPairs.slice(0, 5)) {
    gaps.push({
      type: "supersession_conflict",
      symbol: String(a["symbol"]),
      description:
        `Two active decisions may conflict on symbol "${String(a["symbol"])}": ` +
        `"${String(a["content"]).slice(0, 50)}" and "${String(b["content"]).slice(0, 50)}"`,
      capture_hint:
        `Run claude-lore review or use reasoning_review to link the supersession chain`,
      estimated_effort: "minutes",
      record_ids: [String(a["id"]), String(b["id"])],
      score: 14,
    });
  }

  // 10. unreviewed_template_records — bootstrap template records never reviewed after 30 days
  const templateRes = await sessionsDb.execute({
    sql: `SELECT COUNT(*) as c, MIN(created_at) as oldest
          FROM (
            SELECT created_at FROM decisions
            WHERE repo = ? AND source LIKE 'template:%'
              AND confidence = 'inferred'
              AND last_reviewed_at IS NULL
            UNION ALL
            SELECT created_at FROM risks
            WHERE repo = ? AND source LIKE 'template:%'
              AND confidence = 'inferred'
              AND last_reviewed_at IS NULL
            UNION ALL
            SELECT created_at FROM deferred_work
            WHERE repo = ? AND source LIKE 'template:%'
              AND confidence = 'inferred'
              AND last_reviewed_at IS NULL
          )`,
    args: [repo, repo, repo],
  });

  const templateCount = Number((templateRes.rows[0] as Record<string, unknown>)["c"] ?? 0);
  const templateOldest = (templateRes.rows[0] as Record<string, unknown>)["oldest"];
  if (templateCount > 0 && templateOldest != null) {
    const oldestDays = ageDays(Number(templateOldest));
    if (oldestDays > 30) {
      gaps.push({
        type: "unreviewed_template_records",
        description:
          `${templateCount} bootstrap template records have never been reviewed ` +
          `(oldest: ${oldestDays} days). Template records are generic starting points — ` +
          `review them in context of this codebase.`,
        capture_hint: `Run: claude-lore review  (template records surface at high priority)`,
        estimated_effort: templateCount > 10 ? "hours" : "minutes",
        score: templateCount > 20 ? 13 : 8,
      });
    }
  }

  // 11. unresolved_conflict — contested records unresolved for more than 7 days
  const contestedRes = await sessionsDb.execute({
    sql: `SELECT id, content, symbol, created_at
          FROM decisions
          WHERE repo = ?
            AND confidence = 'contested'
            AND last_reviewed_at IS NULL
            AND created_at < (unixepoch() - (7 * 24 * 60 * 60))`,
    args: [repo],
  });

  for (const row of contestedRes.rows) {
    const r = row as Record<string, unknown>;
    const createdSec = Number(r["created_at"] ?? 0);
    const nowSec = Math.floor(Date.now() / 1000);
    const daysContested = Math.round((nowSec - createdSec) / 86400);
    gaps.push({
      type: "unresolved_conflict",
      symbol: r["symbol"] != null ? String(r["symbol"]) : undefined,
      description:
        `Decision "${String(r["content"]).slice(0, 60)}" has been contested for ` +
        `${daysContested} days with no resolution`,
      capture_hint: `Run: claude-lore review  and choose which version is correct`,
      estimated_effort: "minutes",
      record_id: String(r["id"]),
      score: 15,
      age_days: daysContested,
    });
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
