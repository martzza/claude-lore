import { sessionsDb, personalDb } from "../sqlite/db.js";
import { randomUUID } from "crypto";
import { getGitEmail } from "../sync/service.js";
import { STALENESS_THRESHOLDS } from "../../types/lifecycle.js";

// ---------------------------------------------------------------------------
// Confidence presentation
// ---------------------------------------------------------------------------

export function applyConfidencePrefix(confidence: string, content: string): string {
  switch (confidence) {
    case "confirmed":
      return content;
    case "extracted":
      return `session records suggest: ${content}`;
    case "inferred":
      return `inferred from documentation: ${content}`;
    case "contested":
      return `conflicting records exist: ${content}`;
    default:
      return content;
  }
}

function prefixRow(row: Record<string, unknown>): Record<string, unknown> {
  const confidence = String(row["confidence"] ?? "extracted");
  return {
    ...row,
    content: applyConfidencePrefix(confidence, String(row["content"] ?? "")),
  };
}

// ---------------------------------------------------------------------------
// reasoning_get — decisions + deferred + risks for a symbol
// ---------------------------------------------------------------------------

export interface ReasoningGetResult {
  decisions: Record<string, unknown>[];
  deferred: Record<string, unknown>[];
  risks: Record<string, unknown>[];
}

export async function getReasoningData(
  symbol?: string,
  repo?: string,
  service?: string,
): Promise<ReasoningGetResult> {
  const where: string[] = ["deprecated_by IS NULL", "lifecycle_status = 'active'"];
  const args: (string | null)[] = [];

  if (repo) {
    where.push("repo = ?");
    args.push(repo);
  }
  if (symbol) {
    where.push("symbol = ?");
    args.push(symbol);
  }
  if (service !== undefined) {
    where.push("service IS ?");
    args.push(service ?? null);
  }

  const clause = `WHERE ${where.join(" AND ")}`;

  const [decisionsRes, deferredRes, risksRes] = await Promise.all([
    sessionsDb.execute({ sql: `SELECT * FROM decisions ${clause} ORDER BY created_at DESC`, args }),
    sessionsDb.execute({
      sql: `SELECT * FROM deferred_work ${clause} AND status = 'open' ORDER BY created_at DESC`,
      args,
    }),
    sessionsDb.execute({ sql: `SELECT * FROM risks ${clause} ORDER BY created_at DESC`, args }),
  ]);

  return {
    decisions: decisionsRes.rows.map((r) => prefixRow(r as Record<string, unknown>)),
    deferred: deferredRes.rows.map((r) => prefixRow(r as Record<string, unknown>)),
    risks: risksRes.rows.map((r) => prefixRow(r as Record<string, unknown>)),
  };
}

// ---------------------------------------------------------------------------
// reasoning_get grouped — 3 lifecycle groups + conflict pairs
// ---------------------------------------------------------------------------

export interface ConflictPair {
  symbol: string | null;
  records: Array<{ id: string; content: string; created_at: number }>;
}

export interface ReasoningGetGrouped {
  active: {
    decisions: Record<string, unknown>[];
    deferred: Record<string, unknown>[];
    risks: Record<string, unknown>[];
  };
  historical: {
    decisions: Record<string, unknown>[];
  };
  superseded: {
    decisions: Record<string, unknown>[];
  };
  conflicts: ConflictPair[];
}

export async function getReasoningDataGrouped(
  symbol?: string,
  repo?: string,
  service?: string,
): Promise<ReasoningGetGrouped> {
  const baseWhere: string[] = [];
  const baseArgs: (string | null)[] = [];
  if (repo) { baseWhere.push("repo = ?"); baseArgs.push(repo); }
  if (symbol) { baseWhere.push("symbol = ?"); baseArgs.push(symbol); }
  if (service !== undefined) { baseWhere.push("service IS ?"); baseArgs.push(service ?? null); }

  const baseClause = baseWhere.length > 0 ? ` AND ${baseWhere.join(" AND ")}` : "";

  const nowSec = Math.floor(Date.now() / 1000);
  const decisionThresh = STALENESS_THRESHOLDS["decision"];
  const riskThresh     = STALENESS_THRESHOLDS["risk"];

  const [activeDecRes, activeDeferRes, activeRiskRes, supersededRes, contestedRes] =
    await Promise.all([
      sessionsDb.execute({
        sql: `SELECT * FROM decisions WHERE lifecycle_status = 'active' AND deprecated_by IS NULL${baseClause} ORDER BY created_at DESC`,
        args: baseArgs,
      }),
      sessionsDb.execute({
        sql: `SELECT * FROM deferred_work WHERE lifecycle_status = 'active' AND deprecated_by IS NULL AND status = 'open'${baseClause} ORDER BY created_at DESC`,
        args: baseArgs,
      }),
      sessionsDb.execute({
        sql: `SELECT * FROM risks WHERE lifecycle_status = 'active' AND deprecated_by IS NULL${baseClause} ORDER BY created_at DESC`,
        args: baseArgs,
      }),
      sessionsDb.execute({
        sql: `SELECT id, symbol, content, created_at, superseded_by, superseded_at FROM decisions WHERE lifecycle_status = 'superseded'${baseClause} ORDER BY superseded_at DESC LIMIT 20`,
        args: baseArgs,
      }),
      sessionsDb.execute({
        sql: `SELECT id, symbol, content, created_at FROM decisions WHERE confidence = 'contested' AND lifecycle_status = 'active'${baseClause} ORDER BY symbol, created_at DESC`,
        args: baseArgs,
      }),
    ]);

  // Split active decisions into active vs historical by staleness
  const activeDecisions: Record<string, unknown>[] = [];
  const historicalDecisions: Record<string, unknown>[] = [];
  for (const row of activeDecRes.rows) {
    const r = row as Record<string, unknown>;
    const createdSec = Number(r["created_at"] ?? 0) / 1000; // stored ms
    const lastReview = r["last_reviewed_at"] != null ? Number(r["last_reviewed_at"]) : null;
    const age = nowSec - createdSec;
    const stale = age > decisionThresh && (lastReview === null || nowSec - lastReview > decisionThresh);
    (stale ? historicalDecisions : activeDecisions).push(prefixRow(r));
  }

  // Split active risks — mark unverified ones but keep in active group (risks don't graduate to historical)
  const activeRisks = activeRiskRes.rows.map((row) => {
    const r = row as Record<string, unknown>;
    const createdSec = Number(r["created_at"] ?? 0) / 1000;
    const lastReview = r["last_reviewed_at"] != null ? Number(r["last_reviewed_at"]) : null;
    const age = nowSec - createdSec;
    const unverified = age > riskThresh && (lastReview === null || nowSec - lastReview > riskThresh);
    return prefixRow({ ...r, unverified });
  });

  // Group contested records into ConflictPair by symbol
  const conflictMap = new Map<string | null, Array<{ id: string; content: string; created_at: number }>>();
  for (const row of contestedRes.rows) {
    const r = row as Record<string, unknown>;
    const sym = r["symbol"] != null ? String(r["symbol"]) : null;
    const key = sym ?? "__no_symbol__";
    if (!conflictMap.has(key)) conflictMap.set(key, []);
    conflictMap.get(key)!.push({
      id: String(r["id"]),
      content: String(r["content"]),
      created_at: Number(r["created_at"]),
    });
  }
  const conflicts: ConflictPair[] = [];
  for (const [key, records] of conflictMap) {
    if (records.length >= 2) {
      conflicts.push({ symbol: key === "__no_symbol__" ? null : key, records });
    }
  }

  return {
    active: {
      decisions: activeDecisions,
      deferred: activeDeferRes.rows.map((r) => prefixRow(r as Record<string, unknown>)),
      risks: activeRisks,
    },
    historical: { decisions: historicalDecisions },
    superseded: { decisions: supersededRes.rows as Record<string, unknown>[] },
    conflicts,
  };
}

// ---------------------------------------------------------------------------
// reasoning_log — write a record with confidence "extracted"
// ---------------------------------------------------------------------------

export interface SupersessionCandidate {
  id: string;
  content: string;
  symbol: string | null;
  created_at: number;
  confidence: string;
}

/** Returns existing active decisions on the same symbol for MCP supersession prompting. */
export async function findMcpSupersessionCandidates(
  repo: string,
  symbol: string | undefined,
): Promise<SupersessionCandidate[]> {
  if (!symbol) return [];
  const res = await sessionsDb.execute({
    sql: `SELECT id, content, symbol, created_at, confidence
          FROM decisions
          WHERE repo = ?
            AND symbol = ?
            AND lifecycle_status = 'active'
            AND deprecated_by IS NULL
          ORDER BY created_at DESC
          LIMIT 5`,
    args: [repo, symbol],
  });
  return res.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: String(row["id"]),
      content: String(row["content"]),
      symbol: row["symbol"] != null ? String(row["symbol"]) : null,
      created_at: Number(row["created_at"]),
      confidence: String(row["confidence"]),
    };
  });
}

export async function logReasoning(
  type: "decision" | "deferred" | "risk",
  content: string,
  symbol?: string,
  repo?: string,
  sessionId?: string,
  service?: string,
  supersedes?: string,
  amendmentOf?: string,
): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  const repoVal = repo ?? process.cwd();
  const sessionVal = sessionId ?? null;
  const createdBy = getGitEmail();

  if (type === "decision") {
    await sessionsDb.execute({
      sql: `INSERT OR IGNORE INTO decisions
              (id, repo, session_id, symbol, content, confidence, exported_tier, anchor_status,
               created_at, service, created_by, supersedes, amendment_of)
            VALUES (?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', ?, ?, ?, ?, ?)`,
      args: [id, repoVal, sessionVal, symbol ?? null, content, now, service ?? null, createdBy,
             supersedes ?? null, amendmentOf ?? null],
    });
    // If this decision supersedes an existing one, update the old record
    if (supersedes) {
      await sessionsDb.execute({
        sql: `UPDATE decisions
              SET lifecycle_status = 'superseded',
                  superseded_by = ?,
                  superseded_at = unixepoch()
              WHERE id = ? AND repo = ? AND lifecycle_status = 'active'`,
        args: [id, supersedes, repoVal],
      });
    }
  } else if (type === "deferred") {
    await sessionsDb.execute({
      sql: `INSERT OR IGNORE INTO deferred_work
              (id, repo, session_id, symbol, content, confidence, exported_tier, anchor_status, status, created_at, service, created_by)
            VALUES (?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', 'open', ?, ?, ?)`,
      args: [id, repoVal, sessionVal, symbol ?? null, content, now, service ?? null, createdBy],
    });
  } else {
    await sessionsDb.execute({
      sql: `INSERT OR IGNORE INTO risks
              (id, repo, session_id, symbol, content, confidence, exported_tier, anchor_status, created_at, service, created_by)
            VALUES (?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', ?, ?, ?)`,
      args: [id, repoVal, sessionVal, symbol ?? null, content, now, service ?? null, createdBy],
    });
  }

  return id;
}

// ---------------------------------------------------------------------------
// Confirmation loop
// ---------------------------------------------------------------------------

const SESSIONS_DB_TABLES = new Set(["decisions", "deferred_work", "risks"]);
const PERSONAL_DB_TABLES = new Set(["personal_records"]);

export async function confirmRecord(id: string, table: string): Promise<void> {
  const email = getGitEmail();
  if (SESSIONS_DB_TABLES.has(table)) {
    await sessionsDb.execute({
      sql: `UPDATE ${table}
            SET confidence = 'confirmed',
                confirmed_by = ?,
                last_reviewed_at = unixepoch(),
                reviewed_by = ?
            WHERE id = ?`,
      args: [email, email, id],
    });
  } else if (PERSONAL_DB_TABLES.has(table)) {
    await personalDb.execute({
      sql: `UPDATE ${table} SET confidence = 'confirmed', confirmed_by = ? WHERE id = ?`,
      args: [email, id],
    });
  } else {
    throw new Error(`Unknown table: ${table}`);
  }
}

export async function discardRecord(id: string, table: string): Promise<void> {
  if (SESSIONS_DB_TABLES.has(table)) {
    await sessionsDb.execute({ sql: `DELETE FROM ${table} WHERE id = ?`, args: [id] });
  } else if (PERSONAL_DB_TABLES.has(table)) {
    await personalDb.execute({ sql: `DELETE FROM ${table} WHERE id = ?`, args: [id] });
  } else {
    throw new Error(`Unknown table: ${table}`);
  }
}

/** Delete all records in a repo that were written by a specific source (e.g. "template:sample"). */
export async function discardBySource(repo: string, source: string): Promise<number> {
  const tables = ["decisions", "deferred_work", "risks"] as const;
  let total = 0;
  for (const table of tables) {
    const res = await sessionsDb.execute({
      sql: `DELETE FROM ${table} WHERE repo = ? AND source = ?`,
      args: [repo, source],
    });
    total += res.rowsAffected ?? 0;
  }
  return total;
}

export interface PendingRecord {
  id: string;
  table: string;
  type: string; // "decision" | "deferred" | "risk"
  repo: string;
  service: string | null;
  confidence: string;
  content: string;
  symbol: string | null;
  created_at: number;
  priority_score: number;
  group: "audit_queue" | "needs_review";
}

const TABLE_TO_TYPE: Record<string, string> = {
  decisions: "decision",
  deferred_work: "deferred",
  risks: "risk",
  personal_records: "personal",
};

function pendingPriorityScore(
  table: string,
  confidence: string,
  pendingReview: number,
): number {
  let score = 0;
  if (pendingReview) score += 10;
  if (confidence === "inferred") score += 3;
  if (table === "risks") score += 2;
  else if (table === "decisions") score += 1;
  return score;
}

export async function getPendingRecords(repo?: string, service?: string, auditOnly = false): Promise<PendingRecord[]> {
  const where: string[] = ["deprecated_by IS NULL", "lifecycle_status = 'active'"];

  if (auditOnly) {
    where.push("pending_review = 1");
  } else {
    where.push("(confidence IN (?, ?) OR pending_review = 1)");
  }

  const args: (string | null)[] = auditOnly ? [] : ["extracted", "inferred"];

  if (repo) {
    where.push("repo = ?");
    args.push(repo);
  }
  if (service !== undefined) {
    where.push("service IS ?");
    args.push(service ?? null);
  }

  const clause = `WHERE ${where.join(" AND ")}`;
  const tables = ["decisions", "deferred_work", "risks"] as const;

  const results: PendingRecord[] = [];
  for (const table of tables) {
    const res = await sessionsDb.execute({
      sql: `SELECT id, repo, service, confidence, content, symbol, created_at, pending_review
            FROM ${table}
            ${clause}
            ORDER BY created_at DESC`,
      args,
    });
    for (const row of res.rows) {
      const r = row as Record<string, unknown>;
      const confidence = String(r["confidence"]);
      const pendingReview = Number(r["pending_review"] ?? 0);
      const priorityScore = pendingPriorityScore(table, confidence, pendingReview);
      results.push({
        id: String(r["id"]),
        table,
        type: TABLE_TO_TYPE[table] ?? table,
        repo: String(r["repo"]),
        service: r["service"] != null ? String(r["service"]) : null,
        confidence,
        content: String(r["content"]),
        symbol: r["symbol"] != null ? String(r["symbol"]) : null,
        created_at: Number(r["created_at"]),
        priority_score: priorityScore,
        group: pendingReview ? "audit_queue" : "needs_review",
      });
    }
  }

  // Sort: audit_queue first, then by priority_score desc, then recency
  results.sort((a, b) => {
    if (a.group !== b.group) return a.group === "audit_queue" ? -1 : 1;
    if (b.priority_score !== a.priority_score) return b.priority_score - a.priority_score;
    return b.created_at - a.created_at;
  });
  return results;
}

// ---------------------------------------------------------------------------
// Personal records
// ---------------------------------------------------------------------------

export async function logPersonal(
  type: string,
  content: string,
  symbol?: string,
  repo?: string,
): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await personalDb.execute({
    sql: `INSERT OR IGNORE INTO personal_records
            (id, repo, type, symbol, content, confidence, exported_tier, anchor_status, created_at)
          VALUES (?, ?, ?, ?, ?, 'extracted', 'personal', 'healthy', ?)`,
    args: [id, repo ?? process.cwd(), type, symbol ?? null, content, now],
  });
  return id;
}

export async function getPersonal(
  symbol?: string,
  repo?: string,
): Promise<Record<string, unknown>[]> {
  const where: string[] = [];
  const args: (string | null)[] = [];

  if (repo) {
    where.push("repo = ?");
    args.push(repo);
  }
  if (symbol) {
    where.push("symbol = ?");
    args.push(symbol);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const res = await personalDb.execute({
    sql: `SELECT * FROM personal_records ${clause} ORDER BY created_at DESC LIMIT 50`,
    args,
  });

  return res.rows.map((r) => prefixRow(r as Record<string, unknown>));
}
