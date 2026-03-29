import { sessionsDb, personalDb } from "../sqlite/db.js";
import { randomUUID } from "crypto";
import { execSync } from "child_process";

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
): Promise<ReasoningGetResult> {
  const where: string[] = [];
  const args: unknown[] = [];

  if (repo) {
    where.push("repo = ?");
    args.push(repo);
  }
  if (symbol) {
    where.push("symbol = ?");
    args.push(symbol);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const [decisionsRes, deferredRes, risksRes] = await Promise.all([
    sessionsDb.execute({ sql: `SELECT * FROM decisions ${clause} ORDER BY created_at DESC`, args }),
    sessionsDb.execute({
      sql: `SELECT * FROM deferred_work ${clause} ${clause ? "AND status = 'open'" : "WHERE status = 'open'"} ORDER BY created_at DESC`,
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
// reasoning_log — write a record with confidence "extracted"
// ---------------------------------------------------------------------------

export async function logReasoning(
  type: "decision" | "deferred" | "risk",
  content: string,
  symbol?: string,
  repo?: string,
  sessionId?: string,
): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  const repoVal = repo ?? process.cwd();
  const sessionVal = sessionId ?? null;

  if (type === "decision") {
    await sessionsDb.execute({
      sql: `INSERT OR IGNORE INTO decisions
              (id, repo, session_id, symbol, content, confidence, exported_tier, anchor_status, created_at)
            VALUES (?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', ?)`,
      args: [id, repoVal, sessionVal, symbol ?? null, content, now],
    });
  } else if (type === "deferred") {
    await sessionsDb.execute({
      sql: `INSERT OR IGNORE INTO deferred_work
              (id, repo, session_id, symbol, content, confidence, exported_tier, anchor_status, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', 'open', ?)`,
      args: [id, repoVal, sessionVal, symbol ?? null, content, now],
    });
  } else {
    await sessionsDb.execute({
      sql: `INSERT OR IGNORE INTO risks
              (id, repo, session_id, symbol, content, confidence, exported_tier, anchor_status, created_at)
            VALUES (?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', ?)`,
      args: [id, repoVal, sessionVal, symbol ?? null, content, now],
    });
  }

  return id;
}

// ---------------------------------------------------------------------------
// Confirmation loop
// ---------------------------------------------------------------------------

const SESSIONS_DB_TABLES = new Set(["decisions", "deferred_work", "risks"]);
const PERSONAL_DB_TABLES = new Set(["personal_records"]);

function getGitEmail(): string {
  try {
    return execSync("git config user.email", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export async function confirmRecord(id: string, table: string): Promise<void> {
  const email = getGitEmail();
  if (SESSIONS_DB_TABLES.has(table)) {
    await sessionsDb.execute({
      sql: `UPDATE ${table} SET confidence = 'confirmed', confirmed_by = ? WHERE id = ?`,
      args: [email, id],
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
  confidence: string;
  content: string;
  symbol: string | null;
  created_at: number;
}

const TABLE_TO_TYPE: Record<string, string> = {
  decisions: "decision",
  deferred_work: "deferred",
  risks: "risk",
  personal_records: "personal",
};

export async function getPendingRecords(repo?: string): Promise<PendingRecord[]> {
  const repoClause = repo ? "AND repo = ?" : "";
  const args = repo ? ["extracted", "inferred", repo] : ["extracted", "inferred"];
  const tables = ["decisions", "deferred_work", "risks"] as const;

  const results: PendingRecord[] = [];
  for (const table of tables) {
    const res = await sessionsDb.execute({
      sql: `SELECT id, repo, confidence, content, symbol, created_at
            FROM ${table}
            WHERE confidence IN (?, ?) ${repoClause}
            ORDER BY created_at DESC`,
      args,
    });
    for (const row of res.rows) {
      const r = row as Record<string, unknown>;
      results.push({
        id: String(r["id"]),
        table,
        type: TABLE_TO_TYPE[table] ?? table,
        repo: String(r["repo"]),
        confidence: String(r["confidence"]),
        content: String(r["content"]),
        symbol: r["symbol"] != null ? String(r["symbol"]) : null,
        created_at: Number(r["created_at"]),
      });
    }
  }

  results.sort((a, b) => b.created_at - a.created_at);
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
  const args: unknown[] = [];

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
