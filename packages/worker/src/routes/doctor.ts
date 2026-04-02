import { Router } from "express";
import { sessionsDb } from "../services/sqlite/db.js";

const router = Router();

// Expected columns per table (authoritative — matches db.ts migrations).
const EXPECTED_COLUMNS: Record<string, string[]> = {
  sessions: [
    "id", "repo", "started_at", "ended_at", "summary", "status", "created_at", "service",
  ],
  decisions: [
    "id", "repo", "session_id", "symbol", "content", "rationale", "confidence",
    "exported_tier", "anchor_status", "created_at", "confirmed_by", "original_symbol",
    "anchor_updated_at", "source", "fingerprint", "adr_status", "adr_title",
    "adr_context", "adr_alternatives", "created_by", "deprecated_by", "deprecated_at",
    "pending_review", "audit_id", "service",
  ],
  deferred_work: [
    "id", "repo", "session_id", "symbol", "content", "confidence", "exported_tier",
    "anchor_status", "status", "created_at", "blocked_by", "confirmed_by",
    "original_symbol", "source", "fingerprint", "created_by", "deprecated_by",
    "deprecated_at", "pending_review", "audit_id", "service",
  ],
  risks: [
    "id", "repo", "session_id", "symbol", "content", "confidence", "exported_tier",
    "anchor_status", "created_at", "confirmed_by", "original_symbol", "source",
    "fingerprint", "created_by", "deprecated_by", "deprecated_at", "pending_review",
    "audit_id", "service",
  ],
  skill_manifest: [
    "id", "repo", "skill_name", "file_hash", "created_at", "scope", "updated_at",
  ],
};

// GET /api/doctor — schema health + stuck session count
router.get("/", async (_req, res) => {
  try {
    const schema: Record<string, { columns: string[]; missing: string[] }> = {};

    for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
      const result = await sessionsDb.execute({ sql: `PRAGMA table_info(${table})`, args: [] });
      const actual = result.rows.map((r) => String(r["name"] ?? ""));
      const missing = expected.filter((col) => !actual.includes(col));
      schema[table] = { columns: actual, missing };
    }

    // Sessions stuck in 'active' for over an hour
    const stuckResult = await sessionsDb.execute({
      sql: `SELECT COUNT(*) as n FROM sessions WHERE status = 'active' AND started_at < (unixepoch() - 3600)`,
      args: [],
    });
    const stuckSessions = Number(stuckResult.rows[0]?.["n"] ?? 0);

    res.json({ schema, stuck_sessions: stuckSessions });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/doctor/fix-stuck — mark stuck sessions as completed
router.post("/fix-stuck", async (_req, res) => {
  try {
    const now = Math.floor(Date.now() / 1000);
    await sessionsDb.execute({
      sql: `UPDATE sessions SET status = 'completed', ended_at = ? WHERE status = 'active' AND started_at < (unixepoch() - 3600)`,
      args: [now],
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
