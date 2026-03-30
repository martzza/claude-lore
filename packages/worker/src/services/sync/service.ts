import { execSync } from "child_process";
import { randomUUID } from "crypto";
import { sessionsDb, registryDb, syncNow, hasTurso } from "../sqlite/db.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface SyncLogEntry {
  id: string;
  synced_at: number;
  status: "success" | "failed" | "skipped";
  duration_ms: number;
  sessions_changed: number;
  registry_changed: number;
  error: string | null;
}

export interface SyncConflict {
  id: string;
  detected_at: number;
  repo: string;
  table_name: string;
  record_id: string;
  conflict_type: "overwritten" | "remote_confirmation";
  local_content: string | null;
  remote_content: string | null;
  local_confirmed_by: string | null;
  remote_confirmed_by: string | null;
  resolved: boolean;
}

export interface SyncStatus {
  turso_connected: boolean;
  last_sync: SyncLogEntry | null;
  unresolved_conflicts: number;
}

// ─── Git identity ──────────────────────────────────────────────────────────────

export function getGitEmail(): string {
  try {
    return execSync("git config user.email", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "unknown";
  }
}

// ─── Conflict detection ────────────────────────────────────────────────────────

/**
 * Snapshot confirmed records before sync so we can detect overwrites afterward.
 * Returns a map of record_id → { content, confirmed_by, table }
 */
async function snapshotConfirmed(): Promise<Map<string, { content: string; confirmed_by: string; table: string; repo: string }>> {
  const snap = new Map<string, { content: string; confirmed_by: string; table: string; repo: string }>();
  const tables = ["decisions", "deferred_work", "risks"] as const;
  for (const table of tables) {
    const res = await sessionsDb.execute({
      sql: `SELECT id, content, confirmed_by, repo FROM ${table} WHERE confidence = 'confirmed' AND confirmed_by IS NOT NULL`,
      args: [],
    });
    for (const row of res.rows) {
      const r = row as Record<string, unknown>;
      snap.set(String(r["id"]), {
        content: String(r["content"]),
        confirmed_by: String(r["confirmed_by"]),
        table,
        repo: String(r["repo"]),
      });
    }
  }
  return snap;
}

/**
 * After sync: compare snapshot against current state.
 * Detect two conflict types:
 *   overwritten — a locally confirmed record now has different content (remote won)
 *   remote_confirmation — a confirmed record appeared that wasn't in our snapshot
 *     (a teammate confirmed something we hadn't seen)
 */
async function detectConflicts(
  preSyncSnapshot: Map<string, { content: string; confirmed_by: string; table: string; repo: string }>,
): Promise<number> {
  const now = Date.now();
  const localEmail = getGitEmail();
  let detected = 0;

  const tables = ["decisions", "deferred_work", "risks"] as const;
  for (const table of tables) {
    const res = await sessionsDb.execute({
      sql: `SELECT id, content, confirmed_by, repo FROM ${table} WHERE confidence = 'confirmed' AND confirmed_by IS NOT NULL`,
      args: [],
    });

    for (const row of res.rows) {
      const r = row as Record<string, unknown>;
      const id = String(r["id"]);
      const content = String(r["content"]);
      const confirmedBy = String(r["confirmed_by"]);
      const repo = String(r["repo"]);
      const pre = preSyncSnapshot.get(id);

      // Already have an unresolved conflict for this record — skip
      const existingConflict = await sessionsDb.execute({
        sql: `SELECT id FROM sync_conflicts WHERE record_id = ? AND resolved = 0 LIMIT 1`,
        args: [id],
      });
      if (existingConflict.rows.length > 0) continue;

      if (pre) {
        // Record existed before sync — check if content changed
        if (pre.content !== content) {
          await sessionsDb.execute({
            sql: `INSERT OR IGNORE INTO sync_conflicts
                    (id, detected_at, repo, table_name, record_id, conflict_type,
                     local_content, remote_content, local_confirmed_by, remote_confirmed_by, resolved)
                  VALUES (?, ?, ?, ?, ?, 'overwritten', ?, ?, ?, ?, 0)`,
            args: [randomUUID(), now, repo, table, id, pre.content, content, pre.confirmed_by, confirmedBy],
          });
          detected++;
        }
      } else if (confirmedBy !== localEmail) {
        // New confirmed record from a different author appeared after sync
        await sessionsDb.execute({
          sql: `INSERT OR IGNORE INTO sync_conflicts
                  (id, detected_at, repo, table_name, record_id, conflict_type,
                   local_content, remote_content, local_confirmed_by, remote_confirmed_by, resolved)
                VALUES (?, ?, ?, ?, ?, 'remote_confirmation', NULL, ?, NULL, ?, 0)`,
          args: [randomUUID(), now, repo, table, id, content, confirmedBy],
        });
        detected++;
      }
    }
  }

  return detected;
}

// ─── Sync with retry ───────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

async function syncWithRetry(): Promise<{ ok: boolean; error?: string }> {
  let lastErr = "";
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await sessionsDb.sync();
      await registryDb.sync();
      return { ok: true };
    } catch (err) {
      lastErr = String(err);
      if (attempt < MAX_RETRIES - 1) {
        const delay = BASE_BACKOFF_MS * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  return { ok: false, error: lastErr };
}

// ─── Row count helper ─────────────────────────────────────────────────────────

async function countRows(table: string): Promise<number> {
  try {
    const res = await sessionsDb.execute({ sql: `SELECT COUNT(*) as c FROM ${table}`, args: [] });
    return Number(res.rows[0]!["c"] ?? 0);
  } catch {
    return 0;
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

/** Run a full sync cycle: snapshot → sync → detect conflicts → log result. */
export async function runSync(): Promise<SyncLogEntry> {
  if (!hasTurso()) {
    const entry: SyncLogEntry = {
      id: randomUUID(),
      synced_at: Date.now(),
      status: "skipped",
      duration_ms: 0,
      sessions_changed: 0,
      registry_changed: 0,
      error: "Turso not configured — set CLAUDE_LORE_TURSO_URL and CLAUDE_LORE_TURSO_AUTH_TOKEN",
    };
    return entry;
  }

  const start = Date.now();

  // Pre-sync snapshot for conflict detection
  const snapshot = await snapshotConfirmed();
  const preSessionRows = await countRows("sessions");

  const { ok, error } = await syncWithRetry();
  const duration = Date.now() - start;

  const postSessionRows = await countRows("sessions");
  const sessionsChanged = Math.abs(postSessionRows - preSessionRows);

  let conflictsDetected = 0;
  if (ok) {
    conflictsDetected = await detectConflicts(snapshot);
  }

  const entry: SyncLogEntry = {
    id: randomUUID(),
    synced_at: Date.now(),
    status: ok ? "success" : "failed",
    duration_ms: duration,
    sessions_changed: sessionsChanged,
    registry_changed: 0,
    error: error ?? null,
  };

  await sessionsDb.execute({
    sql: `INSERT INTO sync_log (id, synced_at, status, duration_ms, sessions_changed, registry_changed, error)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [entry.id, entry.synced_at, entry.status, entry.duration_ms, entry.sessions_changed, entry.registry_changed, entry.error],
  });

  if (conflictsDetected > 0) {
    console.warn(`[sync] ${conflictsDetected} conflict${conflictsDetected !== 1 ? "s" : ""} detected after sync`);
  }

  return entry;
}

/** Return the most recent sync log entry. */
export async function getLastSync(): Promise<SyncLogEntry | null> {
  try {
    const res = await sessionsDb.execute({
      sql: `SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 1`,
      args: [],
    });
    if (res.rows.length === 0) return null;
    const r = res.rows[0] as Record<string, unknown>;
    return {
      id: String(r["id"]),
      synced_at: Number(r["synced_at"]),
      status: String(r["status"]) as SyncLogEntry["status"],
      duration_ms: Number(r["duration_ms"]),
      sessions_changed: Number(r["sessions_changed"]),
      registry_changed: Number(r["registry_changed"]),
      error: r["error"] != null ? String(r["error"]) : null,
    };
  } catch {
    return null;
  }
}

/** Return current sync status summary. */
export async function getSyncStatus(): Promise<SyncStatus> {
  const [lastSync, conflictsRes] = await Promise.all([
    getLastSync(),
    sessionsDb.execute({
      sql: `SELECT COUNT(*) as c FROM sync_conflicts WHERE resolved = 0`,
      args: [],
    }).catch(() => ({ rows: [{ c: 0 }] })),
  ]);

  return {
    turso_connected: hasTurso(),
    last_sync: lastSync,
    unresolved_conflicts: Number((conflictsRes.rows[0] as Record<string, unknown>)?.["c"] ?? 0),
  };
}

/** Return unresolved sync conflicts, optionally filtered by repo. */
export async function getSyncConflicts(repo?: string): Promise<SyncConflict[]> {
  const where = ["resolved = 0"];
  const args: string[] = [];
  if (repo) {
    where.push("repo = ?");
    args.push(repo);
  }
  const res = await sessionsDb.execute({
    sql: `SELECT * FROM sync_conflicts WHERE ${where.join(" AND ")} ORDER BY detected_at DESC LIMIT 50`,
    args,
  });
  return res.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r["id"]),
      detected_at: Number(r["detected_at"]),
      repo: String(r["repo"]),
      table_name: String(r["table_name"]),
      record_id: String(r["record_id"]),
      conflict_type: String(r["conflict_type"]) as SyncConflict["conflict_type"],
      local_content: r["local_content"] != null ? String(r["local_content"]) : null,
      remote_content: r["remote_content"] != null ? String(r["remote_content"]) : null,
      local_confirmed_by: r["local_confirmed_by"] != null ? String(r["local_confirmed_by"]) : null,
      remote_confirmed_by: r["remote_confirmed_by"] != null ? String(r["remote_confirmed_by"]) : null,
      resolved: Boolean(r["resolved"]),
    };
  });
}

/** Mark a conflict as resolved. */
export async function resolveConflict(conflictId: string): Promise<void> {
  await sessionsDb.execute({
    sql: `UPDATE sync_conflicts SET resolved = 1 WHERE id = ?`,
    args: [conflictId],
  });
}
