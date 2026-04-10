import { sessionsDb } from "../sqlite/db.js";
import { randomUUID } from "crypto";
import { getGitEmail } from "../sync/service.js";

export interface Session {
  id: string;
  repo: string;
  service: string | null;
  started_at: number;
  ended_at: number | null;
  summary: string | null;
  status: string;
  created_at: number;
}

export async function initSession(sessionId: string, repo: string, service?: string): Promise<void> {
  const now = Date.now();
  await sessionsDb.execute({
    sql: `INSERT OR IGNORE INTO sessions (id, repo, started_at, status, created_at, service)
          VALUES (?, ?, ?, 'active', ?, ?)`,
    args: [sessionId, repo, now, now, service ?? null],
  });
}

const OBSERVATIONS_CAP = 500;
const OBSERVATIONS_EVICT = 100; // remove oldest N when cap is hit

export async function logObservation(
  sessionId: string,
  repo: string,
  toolName: string,
  content: string,
  service?: string,
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
    sql: `INSERT OR IGNORE INTO observations (id, session_id, repo, tool_name, content, created_at, service)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [randomUUID(), sessionId, repo, toolName, content, now, service ?? null],
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
  if (summary !== undefined) {
    // Compression pass — write summary explicitly
    await sessionsDb.execute({
      sql: `UPDATE sessions SET status = 'complete', ended_at = ?, summary = ? WHERE id = ?`,
      args: [now, summary, sessionId],
    });
  } else {
    // Cleanup hook — mark complete but never overwrite a summary already set by compression
    await sessionsDb.execute({
      sql: `UPDATE sessions SET status = 'complete', ended_at = ? WHERE id = ?`,
      args: [now, sessionId],
    });
  }
}

export async function saveDecision(
  sessionId: string,
  repo: string,
  content: string,
  rationale?: string,
  symbol?: string,
  service?: string,
): Promise<void> {
  const now = Date.now();
  const createdBy = getGitEmail();
  await sessionsDb.execute({
    sql: `INSERT OR IGNORE INTO decisions
            (id, repo, session_id, symbol, content, rationale, confidence, exported_tier, anchor_status, created_at, service, created_by)
          VALUES (?, ?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', ?, ?, ?)`,
    args: [randomUUID(), repo, sessionId, symbol ?? null, content, rationale ?? null, now, service ?? null, createdBy],
  });
}

export async function saveDeferredWork(
  sessionId: string,
  repo: string,
  content: string,
  symbol?: string,
  service?: string,
): Promise<void> {
  const now = Date.now();
  const createdBy = getGitEmail();
  await sessionsDb.execute({
    sql: `INSERT OR IGNORE INTO deferred_work
            (id, repo, session_id, symbol, content, confidence, exported_tier, anchor_status, status, created_at, service, created_by)
          VALUES (?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', 'open', ?, ?, ?)`,
    args: [randomUUID(), repo, sessionId, symbol ?? null, content, now, service ?? null, createdBy],
  });
}

export async function saveRisk(
  sessionId: string,
  repo: string,
  content: string,
  symbol?: string,
  service?: string,
): Promise<void> {
  const now = Date.now();
  const createdBy = getGitEmail();
  await sessionsDb.execute({
    sql: `INSERT OR IGNORE INTO risks
            (id, repo, session_id, symbol, content, confidence, exported_tier, anchor_status, created_at, service, created_by)
          VALUES (?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', ?, ?, ?)`,
    args: [randomUUID(), repo, sessionId, symbol ?? null, content, now, service ?? null, createdBy],
  });
}

export async function getLastSessionSummary(repo: string, service?: string): Promise<Session | null> {
  const where = ["repo = ?", "status = 'complete'", "summary IS NOT NULL"];
  const args: (string | null)[] = [repo];
  if (service !== undefined) {
    where.push("service IS ?");
    args.push(service ?? null);
  }
  const result = await sessionsDb.execute({
    sql: `SELECT * FROM sessions WHERE ${where.join(" AND ")} ORDER BY ended_at DESC LIMIT 1`,
    args,
  });
  if (result.rows.length === 0) return null;
  return result.rows[0] as unknown as Session;
}

export async function getOpenDeferredWork(repo: string, service?: string): Promise<unknown[]> {
  const where = ["repo = ?", "status = 'open'", "deprecated_by IS NULL", "lifecycle_status = 'active'"];
  const args: (string | null)[] = [repo];
  if (service !== undefined) {
    where.push("service IS ?");
    args.push(service ?? null);
  }
  const result = await sessionsDb.execute({
    sql: `SELECT * FROM deferred_work WHERE ${where.join(" AND ")} ORDER BY created_at DESC`,
    args,
  });
  return result.rows;
}

export async function checkFirstRun(repo: string): Promise<boolean> {
  const [sessionsRes, decisionsRes, risksRes, deferredRes] = await Promise.all([
    sessionsDb.execute({ sql: `SELECT COUNT(*) as c FROM sessions WHERE repo = ?`, args: [repo] }),
    sessionsDb.execute({ sql: `SELECT COUNT(*) as c FROM decisions WHERE repo = ?`, args: [repo] }),
    sessionsDb.execute({ sql: `SELECT COUNT(*) as c FROM risks WHERE repo = ?`, args: [repo] }),
    sessionsDb.execute({ sql: `SELECT COUNT(*) as c FROM deferred_work WHERE repo = ?`, args: [repo] }),
  ]);
  const sessions = Number(sessionsRes.rows[0]!["c"] ?? 0);
  const decisions = Number(decisionsRes.rows[0]!["c"] ?? 0);
  const risks = Number(risksRes.rows[0]!["c"] ?? 0);
  const deferred = Number(deferredRes.rows[0]!["c"] ?? 0);
  return sessions === 0 && decisions === 0 && risks === 0 && deferred === 0;
}

export async function getSessionStats(
  sessionId: string,
  repo: string,
): Promise<{ observation_count: number; modules_touched: number; unconfirmed_decisions: number }> {
  const sessionRes = await sessionsDb.execute({
    sql: `SELECT started_at FROM sessions WHERE id = ?`,
    args: [sessionId],
  });
  const startedAt = sessionRes.rows.length > 0
    ? Number((sessionRes.rows[0] as Record<string, unknown>)["started_at"] ?? 0)
    : 0;

  const [obsRes, decisionsRes] = await Promise.all([
    sessionsDb.execute({
      sql: `SELECT content FROM observations WHERE session_id = ?`,
      args: [sessionId],
    }),
    sessionsDb.execute({
      sql: `SELECT COUNT(*) as c FROM decisions WHERE repo = ? AND confidence != 'confirmed' AND created_at > ?`,
      args: [repo, startedAt],
    }),
  ]);

  // Extract unique top-level modules from file paths in observation content
  const filePathPattern = /(\/[^\s"']+\.[a-zA-Z]{1,6})/g;
  const modules = new Set<string>();
  for (const row of obsRes.rows) {
    const content = String((row as Record<string, unknown>)["content"] ?? "");
    for (const match of content.matchAll(filePathPattern)) {
      const parts = match[1]!.split("/").filter(Boolean);
      if (parts.length > 1) modules.add(parts[0]!);
    }
  }

  return {
    observation_count: obsRes.rows.length,
    modules_touched: modules.size,
    unconfirmed_decisions: Number(decisionsRes.rows[0]!["c"] ?? 0),
  };
}
