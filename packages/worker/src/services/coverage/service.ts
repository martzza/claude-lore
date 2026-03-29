import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, isAbsolute, resolve } from "path";
import { createClient } from "@libsql/client";
import { sessionsDb } from "../sqlite/db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoverageItem {
  id: string;
  table: string;
  symbol: string | null;
  content: string;
  confidence: string;
  anchor_status: string;
  age_days: number;
}

export interface CoverageReport {
  repo: string;
  generated_at: number;
  high_caller_symbols_without_adr: string[];  // requires structural.db
  orphaned_anchors: CoverageItem[];
  stale_inferred: CoverageItem[];             // inferred + >30 days, no confirmation
  stale_deferred: CoverageItem[];             // open deferred + >14 days + no blocked_by
  structural_db_present: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function ageDays(created_at: number): number {
  return Math.floor((Date.now() - created_at) / MS_PER_DAY);
}

function toItem(
  row: Record<string, unknown>,
  table: string,
): CoverageItem {
  return {
    id: String(row["id"]),
    table,
    symbol: row["symbol"] != null ? String(row["symbol"]) : null,
    content: String(row["content"] ?? ""),
    confidence: String(row["confidence"] ?? "extracted"),
    anchor_status: String(row["anchor_status"] ?? "healthy"),
    age_days: ageDays(Number(row["created_at"] ?? 0)),
  };
}

async function highCallerSymbols(cwd: string): Promise<string[]> {
  // Reject non-absolute paths and anything that resolves outside the supplied dir
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) return [];
  const structuralPath = join(cwd, ".codegraph", "structural.db");
  if (!existsSync(structuralPath)) return [];
  const db = createClient({ url: `file:${structuralPath}` });
  try {
    const res = await db.execute({
      sql: `SELECT callee, COUNT(*) as caller_count
            FROM call_graph
            GROUP BY callee
            HAVING caller_count >= 5`,
      args: [],
    });
    return res.rows.map((r) => String(r["callee"]));
  } catch {
    return []; // call_graph table may not exist yet
  }
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export async function generateCoverageReport(
  repo: string,
  cwd: string,
): Promise<CoverageReport> {
  // Reject non-absolute or traversal paths before writing files to user-supplied cwd
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) {
    throw new Error("cwd must be an absolute, non-traversal path");
  }
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * MS_PER_DAY;
  const fourteenDaysAgo = now - 14 * MS_PER_DAY;
  const tables = ["decisions", "deferred_work", "risks"] as const;

  // 1. High-caller symbols without ADR (structural.db optional)
  const highCallers = await highCallerSymbols(cwd);
  const symbolsWithAdr = new Set<string>();
  if (highCallers.length > 0) {
    for (const sym of highCallers) {
      const res = await sessionsDb.execute({
        sql: `SELECT COUNT(*) as c FROM decisions
              WHERE repo = ? AND symbol = ? AND confidence = 'confirmed'`,
        args: [repo, sym],
      });
      if (Number(res.rows[0]["c"] ?? 0) > 0) symbolsWithAdr.add(sym);
    }
  }
  const highCallerWithoutAdr = highCallers.filter((s) => !symbolsWithAdr.has(s));

  // 2. Orphaned anchors across all record tables
  const orphanedAnchors: CoverageItem[] = [];
  for (const table of tables) {
    const res = await sessionsDb.execute({
      sql: `SELECT id, symbol, content, confidence, anchor_status, created_at
            FROM ${table}
            WHERE repo = ? AND anchor_status = 'orphaned'`,
      args: [repo],
    });
    orphanedAnchors.push(
      ...res.rows.map((r) => toItem(r as Record<string, unknown>, table)),
    );
  }

  // 3. Inferred records older than 30 days with no confirmation
  const staleInferred: CoverageItem[] = [];
  for (const table of tables) {
    const res = await sessionsDb.execute({
      sql: `SELECT id, symbol, content, confidence, anchor_status, created_at
            FROM ${table}
            WHERE repo = ? AND confidence = 'inferred' AND created_at < ?`,
      args: [repo, thirtyDaysAgo],
    });
    staleInferred.push(
      ...res.rows.map((r) => toItem(r as Record<string, unknown>, table)),
    );
  }

  // 4. Open deferred work with no blocked_by older than 14 days
  const staleDeferred: CoverageItem[] = [];
  const deferredRes = await sessionsDb.execute({
    sql: `SELECT id, symbol, content, confidence, anchor_status, created_at, blocked_by
          FROM deferred_work
          WHERE repo = ? AND status = 'open'
            AND (blocked_by IS NULL OR blocked_by = '')
            AND created_at < ?`,
    args: [repo, fourteenDaysAgo],
  });
  staleDeferred.push(
    ...deferredRes.rows.map((r) => toItem(r as Record<string, unknown>, "deferred_work")),
  );

  const report: CoverageReport = {
    repo,
    generated_at: now,
    high_caller_symbols_without_adr: highCallerWithoutAdr,
    orphaned_anchors: orphanedAnchors,
    stale_inferred: staleInferred,
    stale_deferred: staleDeferred,
    structural_db_present: existsSync(join(cwd, ".codegraph", "structural.db")),
  };

  writeReport(cwd, report);
  return report;
}

// ---------------------------------------------------------------------------
// Markdown output
// ---------------------------------------------------------------------------

function writeReport(cwd: string, report: CoverageReport): void {
  const dir = join(cwd, ".codegraph");
  mkdirSync(dir, { recursive: true });

  const date = new Date(report.generated_at).toISOString().slice(0, 10);
  const lines: string[] = [
    `# Coverage Report: ${report.repo}`,
    `Generated: ${date}`,
    ``,
    `## Summary`,
    ``,
    `| Category | Count |`,
    `|---|---|`,
    `| Symbols with 5+ callers and no confirmed decision | ${report.high_caller_symbols_without_adr.length} |`,
    `| Orphaned anchors | ${report.orphaned_anchors.length} |`,
    `| Inferred records >30 days unconfirmed | ${report.stale_inferred.length} |`,
    `| Open deferred >14 days (no blocked_by) | ${report.stale_deferred.length} |`,
    ``,
  ];

  if (!report.structural_db_present) {
    lines.push(
      `> **Note:** No structural.db found at \`{cwd}/.codegraph/structural.db\`.`,
      `> High-caller symbol analysis was skipped.`,
      ``,
    );
  }

  if (report.high_caller_symbols_without_adr.length > 0) {
    lines.push(
      `## High-Caller Symbols Without Confirmed Decision`,
      ``,
      `| Symbol |`,
      `|---|`,
      ...report.high_caller_symbols_without_adr.map((s) => `| \`${s}\` |`),
      ``,
    );
  }

  if (report.orphaned_anchors.length > 0) {
    lines.push(
      `## Orphaned Anchors`,
      ``,
      `| Table | Symbol | Content |`,
      `|---|---|---|`,
      ...report.orphaned_anchors.map(
        (r) => `| ${r.table} | \`${r.symbol ?? "(none)"}\` | ${r.content.slice(0, 80)} |`,
      ),
      ``,
    );
  }

  if (report.stale_inferred.length > 0) {
    lines.push(
      `## Stale Inferred Records (>30 days, unconfirmed)`,
      ``,
      `| Table | Age (days) | Content |`,
      `|---|---|---|`,
      ...report.stale_inferred.map(
        (r) => `| ${r.table} | ${r.age_days} | ${r.content.slice(0, 80)} |`,
      ),
      ``,
    );
  }

  if (report.stale_deferred.length > 0) {
    lines.push(
      `## Stale Deferred Work (>14 days, no blocked_by)`,
      ``,
      `| Age (days) | Content |`,
      `|---|---|`,
      ...report.stale_deferred.map(
        (r) => `| ${r.age_days} | ${r.content.slice(0, 100)} |`,
      ),
      ``,
    );
  }

  writeFileSync(join(dir, "coverage-report.md"), lines.join("\n"));
}
