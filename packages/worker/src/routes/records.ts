import { Router } from "express";
import { z } from "zod";
import { confirmRecord, discardRecord, discardBySource, getPendingRecords } from "../services/reasoning/service.js";
import { sessionsDb } from "../services/sqlite/db.js";
import { requireScope } from "../middleware/auth.js";
import { getGitEmail } from "../services/sync/service.js";

const router = Router();

const VALID_TABLES = new Set(["decisions", "deferred_work", "risks", "personal_records"]);

const RecordRefBody = z.object({
  id: z.string(),
  table: z.string().refine((t) => VALID_TABLES.has(t), {
    message: "table must be one of: decisions, deferred_work, risks, personal_records",
  }),
});

const DiscardBySourceBody = z.object({
  repo: z.string(),
  source: z.string(),
});

// Extended confirm body — supports audit review actions
const ConfirmBody = RecordRefBody.extend({
  action: z.enum(["confirm", "defer", "dismiss", "unknown"]).optional(),
  reasoning: z.string().optional(),
});

// POST /api/records/confirm — promote to "confirmed", optionally with audit action + reasoning
router.post("/confirm", requireScope("write:decisions"), async (req, res) => {
  const parsed = ConfirmBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { id, table, action = "confirm", reasoning } = parsed.data;

  // Simple confirm (original behaviour) — no action or action=confirm
  if (action === "confirm") {
    try {
      await confirmRecord(id, table);
      if (reasoning) {
        await sessionsDb.execute({
          sql: `UPDATE ${table} SET rationale = ?, pending_review = 0 WHERE id = ?`,
          args: [reasoning, id],
        });
      } else {
        await sessionsDb.execute({
          sql: `UPDATE ${table} SET pending_review = 0 WHERE id = ?`,
          args: [id],
        });
      }
      res.json({ ok: true, id, table, action, confidence: "confirmed" });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
    return;
  }

  // action=unknown — leave as-is but clear pending_review so it stops appearing in queue
  if (action === "unknown") {
    try {
      await sessionsDb.execute({
        sql: `UPDATE ${table} SET pending_review = 0 WHERE id = ?`,
        args: [id],
      });
      res.json({ ok: true, id, table, action });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
    return;
  }

  // action=dismiss — soft-delete: mark deprecated_by='dismissed', lifecycle_status='archived', clear pending_review
  if (action === "dismiss") {
    try {
      await sessionsDb.execute({
        sql: `UPDATE ${table}
              SET deprecated_by = 'dismissed',
                  deprecated_at = ?,
                  lifecycle_status = 'archived',
                  pending_review = 0
              WHERE id = ?`,
        args: [Date.now(), id],
      });
      res.json({ ok: true, id, table, action });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
    return;
  }

  // action=defer — only valid for decisions: converts to a deferred_work record
  if (action === "defer") {
    if (table !== "decisions") {
      res.status(400).json({ error: "action=defer is only valid for decisions records" });
      return;
    }
    try {
      // Fetch the original record
      const orig = await sessionsDb.execute({
        sql: `SELECT * FROM decisions WHERE id = ?`,
        args: [id],
      });
      if (orig.rows.length === 0) {
        res.status(404).json({ error: "Record not found" });
        return;
      }
      const row = orig.rows[0] as Record<string, unknown>;
      const email = getGitEmail();
      const now = Date.now();
      const newId = `deferred-${id}`;

      // Write deferred record with provided reasoning as rationale
      await sessionsDb.execute({
        sql: `INSERT OR IGNORE INTO deferred_work
                (id, repo, session_id, symbol, content, confidence, exported_tier,
                 anchor_status, status, source, audit_id, pending_review, confirmed_by, created_at)
              VALUES (?, ?, ?, ?, ?, 'confirmed', ?, 'healthy', 'open', ?, ?, 0, ?, ?)`,
        args: [
          newId,
          String(row["repo"]),
          row["session_id"] != null ? String(row["session_id"]) : null,
          row["symbol"] != null ? String(row["symbol"]) : null,
          reasoning ? `${String(row["content"])} — ${reasoning}` : String(row["content"]),
          String(row["exported_tier"] ?? "private"),
          String(row["source"] ?? "audit:manual"),
          row["audit_id"] != null ? String(row["audit_id"]) : null,
          email,
          now,
        ],
      });

      // Deprecate the original decision record and mark lifecycle as superseded
      await sessionsDb.execute({
        sql: `UPDATE decisions
              SET deprecated_by = ?,
                  deprecated_at = ?,
                  lifecycle_status = 'superseded',
                  pending_review = 0
              WHERE id = ?`,
        args: [newId, now, id],
      });

      res.json({ ok: true, id, new_id: newId, table: "deferred_work", action });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
    return;
  }
});

// POST /api/records/discard — delete a record by id+table or all records by repo+source
router.post("/discard", requireScope("write:decisions"), async (req, res) => {
  // Try { repo, source } first
  const bySource = DiscardBySourceBody.safeParse(req.body);
  if (bySource.success) {
    const { repo, source } = bySource.data;
    try {
      const deleted = await discardBySource(repo, source);
      res.json({ ok: true, repo, source, deleted });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
    return;
  }

  // Fall back to { id, table }
  const parsed = RecordRefBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { id, table } = parsed.data;
  try {
    await discardRecord(id, table);
    res.json({ ok: true, id, table });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// POST /api/records/edit — update content of a record (auto-stays at current confidence)
router.post("/edit", requireScope("write:decisions"), async (req, res) => {
  const parsed = RecordRefBody.extend({ content: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { id, table, content } = parsed.data;
  try {
    const db = sessionsDb;
    await db.execute({ sql: `UPDATE ${table} SET content = ? WHERE id = ?`, args: [content, id] });
    res.json({ ok: true, id, table });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// GET /api/records/pending?repo=&service=&audit_only=true
// audit_only=true filters to records with pending_review=1 (audit gap queue only)
router.get("/pending", async (req, res) => {
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : undefined;
  const service = typeof req.query["service"] === "string" ? req.query["service"] : undefined;
  const auditOnly = req.query["audit_only"] === "true";
  const records = await getPendingRecords(repo, service, auditOnly);
  res.json({ records, count: records.length, total: records.length });
});

// GET /api/records/counts?repo=&service= — summary counts for status command
router.get("/counts", async (req, res) => {
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : undefined;
  const service = typeof req.query["service"] === "string" ? req.query["service"] : undefined;
  if (!repo) {
    res.status(400).json({ error: "repo query param required" });
    return;
  }

  // Build service filter clause for direct COUNT queries
  const svcClause = service !== undefined ? " AND service IS ?" : "";
  const svcArgs = (base: string[]): string[] => service !== undefined ? [...base, service] : base;

  const [decRes, riskRes, defRes, pendingRecords] = await Promise.all([
    sessionsDb.execute({ sql: `SELECT COUNT(*) as c FROM decisions WHERE repo = ?${svcClause}`, args: svcArgs([repo]) }),
    sessionsDb.execute({ sql: `SELECT COUNT(*) as c FROM risks WHERE repo = ?${svcClause}`, args: svcArgs([repo]) }),
    sessionsDb.execute({ sql: `SELECT COUNT(*) as c FROM deferred_work WHERE repo = ? AND status = 'open'${svcClause}`, args: svcArgs([repo]) }),
    getPendingRecords(repo, service),
  ]);
  const blockedRes = await sessionsDb.execute({
    sql: `SELECT COUNT(*) as c FROM deferred_work WHERE repo = ? AND status = 'blocked'${svcClause}`,
    args: svcArgs([repo]),
  });
  res.json({
    ok: true,
    decisions:        Number(decRes.rows[0]!["c"] ?? 0),
    risks:            Number(riskRes.rows[0]!["c"] ?? 0),
    deferred:         Number(defRes.rows[0]!["c"] ?? 0),
    deferred_blocked: Number(blockedRes.rows[0]!["c"] ?? 0),
    pending_review:   pendingRecords.length,
  });
});

// POST /api/records/lifecycle — lifecycle state transitions
// Actions: mitigated | accepted | completed | abandoned | superseded | still_valid | reopen
const LIFECYCLE_TABLES = new Set(["decisions", "deferred_work", "risks"]);

const LifecycleBody = z.object({
  id: z.string(),
  table: z.string().refine((t) => LIFECYCLE_TABLES.has(t), {
    message: "table must be one of: decisions, deferred_work, risks",
  }),
  action: z.enum(["mitigated", "accepted", "completed", "abandoned", "superseded", "still_valid", "reopen"]),
  note: z.string().optional(),
  superseded_by: z.string().optional(), // required when action=superseded
});

router.post("/lifecycle", requireScope("write:decisions"), async (req, res) => {
  const parsed = LifecycleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { id, table, action, note, superseded_by } = parsed.data;
  const email = getGitEmail();
  const now = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();

  try {
    if (action === "still_valid") {
      // Just update last_reviewed_at — no status change
      await sessionsDb.execute({
        sql: `UPDATE ${table} SET last_reviewed_at = ?, reviewed_by = ? WHERE id = ?`,
        args: [now, email, id],
      });
      res.json({ ok: true, id, table, action });
      return;
    }

    if (action === "reopen") {
      // Restore to active — only valid when currently not active
      await sessionsDb.execute({
        sql: `UPDATE ${table} SET lifecycle_status = 'active', deprecated_by = NULL, deprecated_at = NULL,
              last_reviewed_at = ?, reviewed_by = ? WHERE id = ?`,
        args: [now, email, id],
      });
      res.json({ ok: true, id, table, action });
      return;
    }

    if (action === "superseded") {
      if (!superseded_by) {
        res.status(400).json({ error: "superseded_by is required for action=superseded" });
        return;
      }
      await sessionsDb.execute({
        sql: `UPDATE ${table} SET lifecycle_status = 'superseded', superseded_by = ?,
              superseded_at = ?, reviewed_by = ?, last_reviewed_at = ?
              WHERE id = ?`,
        args: [superseded_by, now, email, now, id],
      });
      res.json({ ok: true, id, table, action });
      return;
    }

    if (action === "mitigated" && table === "risks") {
      await sessionsDb.execute({
        sql: `UPDATE risks SET lifecycle_status = 'mitigated', mitigated_at = ?,
              mitigation_confirmed_by = ?, mitigation_note = ?,
              last_reviewed_at = ?, reviewed_by = ? WHERE id = ?`,
        args: [now, email, note ?? null, now, email, id],
      });
      res.json({ ok: true, id, table, action });
      return;
    }

    if (action === "accepted" && table === "risks") {
      await sessionsDb.execute({
        sql: `UPDATE risks SET lifecycle_status = 'accepted', accepted_at = ?,
              accepted_by = ?, acceptance_note = ?,
              last_reviewed_at = ?, reviewed_by = ? WHERE id = ?`,
        args: [now, email, note ?? null, now, email, id],
      });
      res.json({ ok: true, id, table, action });
      return;
    }

    if (action === "completed" && table === "deferred_work") {
      await sessionsDb.execute({
        sql: `UPDATE deferred_work SET lifecycle_status = 'completed', status = 'done',
              resolved_how = 'completed', resolved_note = ?, resolved_at = ?,
              last_reviewed_at = ?, reviewed_by = ? WHERE id = ?`,
        args: [note ?? null, nowMs, now, email, id],
      });
      res.json({ ok: true, id, table, action });
      return;
    }

    if (action === "abandoned" && table === "deferred_work") {
      await sessionsDb.execute({
        sql: `UPDATE deferred_work SET lifecycle_status = 'abandoned', status = 'done',
              resolved_how = 'abandoned', resolved_note = ?, resolved_at = ?,
              last_reviewed_at = ?, reviewed_by = ? WHERE id = ?`,
        args: [note ?? null, nowMs, now, email, id],
      });
      res.json({ ok: true, id, table, action });
      return;
    }

    // Fallthrough: action+table combo not supported
    res.status(400).json({ error: `action '${action}' is not valid for table '${table}'` });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

export default router;
