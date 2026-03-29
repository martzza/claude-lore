import { sessionsDb } from "../sqlite/db.js";
import { randomUUID } from "crypto";

export interface Session {
  id: string;
  repo: string;
  started_at: number;
  ended_at: number | null;
  summary: string | null;
  status: string;
  created_at: number;
}

export async function initSession(sessionId: string, repo: string): Promise<void> {
  const now = Date.now();
  await sessionsDb.execute({
    sql: `INSERT OR IGNORE INTO sessions (id, repo, started_at, status, created_at)
          VALUES (?, ?, ?, 'active', ?)`,
    args: [sessionId, repo, now, now],
  });
}

const OBSERVATIONS_CAP = 500;
const OBSERVATIONS_EVICT = 100; // remove oldest N when cap is hit

export async function logObservation(
  sessionId: string,
  repo: string,
  toolName: string,
  content: string,
): Promise<void> {
  const now = Date.now();

  // Ring-buffer: if at cap, evict the oldest OBSERVATIONS_EVICT rows for this session
  const countRes = await sessionsDb.execute({
    sql: `SELECT COUNT(*) as c FROM observations WHERE session_id = ?`,
    args: [sessionId],
  });
  const count = Number(countRes.rows[0]["c"] ?? 0);
  if (count >= OBSERVATIONS_CAP) {
    console.warn(`[observations] session ${sessionId} hit cap (${OBSERVATIONS_CAP}), evicting ${OBSERVATIONS_EVICT} oldest`);
    await sessionsDb.execute({
      sql: `DELETE FROM observations WHERE id IN (
              SELECT id FROM observations WHERE session_id = ?
              ORDER BY created_at ASC LIMIT ?
            )`,
      args: [sessionId, OBSERVATIONS_EVICT],
    });
  }

  await sessionsDb.execute({
    sql: `INSERT OR IGNORE INTO observations (id, session_id, repo, tool_name, content, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [randomUUID(), sessionId, repo, toolName, content, now],
  });
}

export async function getSessionObservations(sessionId: string): Promise<unknown[]> {
  const result = await sessionsDb.execute({
    sql: `SELECT * FROM observations WHERE session_id = ? ORDER BY created_at ASC`,
    args: [sessionId],
  });
  return result.rows;
}

export async function isSessionComplete(sessionId: string): Promise<boolean> {
  const res = await sessionsDb.execute({
    sql: `SELECT status FROM sessions WHERE id = ?`,
    args: [sessionId],
  });
  if (res.rows.length === 0) return false;
  return String(res.rows[0]["status"]) === "complete";
}

export async function completeSession(
  sessionId: string,
  summary?: string,
): Promise<void> {
  const now = Date.now();
  await sessionsDb.execute({
    sql: `UPDATE sessions SET status = 'complete', ended_at = ?, summary = ?
          WHERE id = ?`,
    args: [now, summary ?? null, sessionId],
  });
}

export async function saveDecision(
  sessionId: string,
  repo: string,
  content: string,
  rationale?: string,
  symbol?: string,
): Promise<void> {
  const now = Date.now();
  await sessionsDb.execute({
    sql: `INSERT OR IGNORE INTO decisions
            (id, repo, session_id, symbol, content, rationale, confidence, exported_tier, anchor_status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', ?)`,
    args: [randomUUID(), repo, sessionId, symbol ?? null, content, rationale ?? null, now],
  });
}

export async function saveDeferredWork(
  sessionId: string,
  repo: string,
  content: string,
  symbol?: string,
): Promise<void> {
  const now = Date.now();
  await sessionsDb.execute({
    sql: `INSERT OR IGNORE INTO deferred_work
            (id, repo, session_id, symbol, content, confidence, exported_tier, anchor_status, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', 'open', ?)`,
    args: [randomUUID(), repo, sessionId, symbol ?? null, content, now],
  });
}

export async function saveRisk(
  sessionId: string,
  repo: string,
  content: string,
  symbol?: string,
): Promise<void> {
  const now = Date.now();
  await sessionsDb.execute({
    sql: `INSERT OR IGNORE INTO risks
            (id, repo, session_id, symbol, content, confidence, exported_tier, anchor_status, created_at)
          VALUES (?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', ?)`,
    args: [randomUUID(), repo, sessionId, symbol ?? null, content, now],
  });
}

export async function getLastSessionSummary(repo: string): Promise<Session | null> {
  const result = await sessionsDb.execute({
    sql: `SELECT * FROM sessions
          WHERE repo = ? AND status = 'complete' AND summary IS NOT NULL
          ORDER BY ended_at DESC LIMIT 1`,
    args: [repo],
  });
  if (result.rows.length === 0) return null;
  return result.rows[0] as unknown as Session;
}

export async function getOpenDeferredWork(repo: string): Promise<unknown[]> {
  const result = await sessionsDb.execute({
    sql: `SELECT * FROM deferred_work WHERE repo = ? AND status = 'open' ORDER BY created_at DESC`,
    args: [repo],
  });
  return result.rows;
}
