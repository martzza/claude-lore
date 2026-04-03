import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { sessionsDb } from "../services/sqlite/db.js";
import { requireScope } from "../middleware/auth.js";

const router = Router();

const AUDIT_TABLES = new Set(["decisions", "deferred_work", "risks"]);

// ---------------------------------------------------------------------------
// POST /api/audit/start — create an audit_run row, return audit_id
// ---------------------------------------------------------------------------

const StartBody = z.object({
  repo: z.string().min(1),
  mode: z.enum(["full", "grep_only", "estimate"]).default("full"),
});

router.post("/start", requireScope("write:sessions"), async (req, res) => {
  const parsed = StartBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { repo, mode } = parsed.data;
  const id = randomUUID();
  const now = Date.now();
  try {
    await sessionsDb.execute({
      sql: `INSERT INTO audit_runs (id, repo, started_at, status, mode, created_at)
            VALUES (?, ?, ?, 'in_progress', ?, ?)`,
      args: [id, repo, now, mode, now],
    });
    res.json({ ok: true, audit_id: id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/audit/complete — update audit_run with final stats
// ---------------------------------------------------------------------------

const CompleteBody = z.object({
  audit_id: z.string().min(1),
  status: z.enum(["completed", "partial"]).default("completed"),
  claims_found: z.number().int().default(0),
  behavioral_claims: z.number().int().default(0),
  gaps_found: z.number().int().default(0),
  records_created: z.number().int().default(0),
  records_deprecated: z.number().int().default(0),
});

router.post("/complete", requireScope("write:sessions"), async (req, res) => {
  const parsed = CompleteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { audit_id, status, claims_found, behavioral_claims, gaps_found, records_created, records_deprecated } = parsed.data;
  try {
    await sessionsDb.execute({
      sql: `UPDATE audit_runs
            SET completed_at = ?, status = ?,
                claims_found = ?, behavioral_claims = ?, gaps_found = ?,
                records_created = ?, records_deprecated = ?
            WHERE id = ?`,
      args: [Date.now(), status, claims_found, behavioral_claims, gaps_found, records_created, records_deprecated, audit_id],
    });
    res.json({ ok: true, audit_id, status });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/audit/status?repo= — latest audit_run for repo
// ---------------------------------------------------------------------------

router.get("/status", async (req, res) => {
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : undefined;
  if (!repo) {
    res.status(400).json({ error: "repo query param required" });
    return;
  }
  try {
    const result = await sessionsDb.execute({
      sql: `SELECT * FROM audit_runs WHERE repo = ? ORDER BY started_at DESC LIMIT 1`,
      args: [repo],
    });
    const run = result.rows[0] ?? null;
    res.json({ ok: true, run });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/audit/deprecate — mark existing records as deprecated
// ---------------------------------------------------------------------------

const DeprecateBody = z.object({
  ids: z.array(z.string().min(1)).min(1),
  table: z.string().refine((t) => AUDIT_TABLES.has(t), {
    message: "table must be one of: decisions, deferred_work, risks",
  }),
  deprecated_by: z.string().min(1),  // ID of the new record replacing them
  audit_id: z.string().min(1),
});

router.post("/deprecate", requireScope("write:sessions"), async (req, res) => {
  const parsed = DeprecateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { ids, table, deprecated_by, audit_id } = parsed.data;
  const now = Date.now();
  try {
    let updated = 0;
    for (const id of ids) {
      const result = await sessionsDb.execute({
        sql: `UPDATE ${table}
              SET deprecated_by = ?, deprecated_at = ?, audit_id = ?
              WHERE id = ? AND deprecated_by IS NULL AND lifecycle_status = 'active'`,
        args: [deprecated_by, now, audit_id, id],
      });
      updated += result.rowsAffected ?? 0;
    }
    res.json({ ok: true, updated, table });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/audit/write-gap — write a gap record with pending_review flag
// ---------------------------------------------------------------------------

const WriteGapBody = z.object({
  repo: z.string().min(1),
  audit_id: z.string().min(1),
  type: z.enum(["decision", "deferred", "risk"]),
  content: z.string().min(1),
  rationale: z.string().optional(),
  symbol: z.string().optional(),
  confidence: z.enum(["confirmed", "inferred"]).default("inferred"),
  pending_review: z.boolean().default(true),
  replaces: z.string().optional(),      // ID of bootstrap record being deprecated
  git_author: z.string().optional(),
  git_date: z.string().optional(),
  git_message: z.string().optional(),
});

router.post("/write-gap", requireScope("write:sessions"), async (req, res) => {
  const parsed = WriteGapBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const {
    repo, audit_id, type, content, rationale, symbol,
    confidence, pending_review, replaces,
    git_author, git_date, git_message,
  } = parsed.data;

  const id = randomUUID();
  const now = Date.now();
  const source = `audit:${audit_id}`;
  const pendingFlag = pending_review ? 1 : 0;

  // Encode git context into rationale if provided and no explicit rationale
  const fullRationale = rationale
    ?? (git_author ? `Last code touch: ${git_author}${git_date ? ` (${git_date})` : ""}${git_message ? ` — "${git_message}"` : ""}` : null);

  try {
    if (type === "decision") {
      await sessionsDb.execute({
        sql: `INSERT OR IGNORE INTO decisions
                (id, repo, session_id, symbol, content, rationale, confidence, exported_tier,
                 anchor_status, source, audit_id, pending_review, created_at)
              VALUES (?, ?, NULL, ?, ?, ?, ?, 'private', 'healthy', ?, ?, ?, ?)`,
        args: [id, repo, symbol ?? null, content, fullRationale ?? null, confidence, source, audit_id, pendingFlag, now],
      });
    } else if (type === "deferred") {
      await sessionsDb.execute({
        sql: `INSERT OR IGNORE INTO deferred_work
                (id, repo, session_id, symbol, content, confidence, exported_tier,
                 anchor_status, status, source, audit_id, pending_review, created_at)
              VALUES (?, ?, NULL, ?, ?, ?, 'private', 'healthy', 'open', ?, ?, ?, ?)`,
        args: [id, repo, symbol ?? null, content, confidence, source, audit_id, pendingFlag, now],
      });
    } else {
      await sessionsDb.execute({
        sql: `INSERT OR IGNORE INTO risks
                (id, repo, session_id, symbol, content, rationale, confidence, exported_tier,
                 anchor_status, source, audit_id, pending_review, created_at)
              VALUES (?, ?, NULL, ?, ?, ?, ?, 'private', 'healthy', ?, ?, ?, ?)`,
        args: [id, repo, symbol ?? null, content, fullRationale ?? null, confidence, source, audit_id, pendingFlag, now],
      });
    }

    // Deprecate the old record if specified
    if (replaces) {
      const tableMap = { decision: "decisions", deferred: "deferred_work", risk: "risks" } as const;
      const table = tableMap[type];
      await sessionsDb.execute({
        sql: `UPDATE ${table} SET deprecated_by = ?, deprecated_at = ?, audit_id = ?
              WHERE id = ? AND deprecated_by IS NULL AND lifecycle_status = 'active'`,
        args: [id, now, audit_id, replaces],
      });
    }

    res.json({ ok: true, id, type, pending_review: pendingFlag });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
