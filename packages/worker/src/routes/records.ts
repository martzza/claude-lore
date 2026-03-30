import { Router } from "express";
import { z } from "zod";
import { confirmRecord, discardRecord, discardBySource, getPendingRecords } from "../services/reasoning/service.js";
import { sessionsDb } from "../services/sqlite/db.js";
import { requireScope } from "../middleware/auth.js";

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

// POST /api/records/confirm — promote to "confirmed", records confirmed_by from git config
router.post("/confirm", requireScope("write:decisions"), async (req, res) => {
  const parsed = RecordRefBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { id, table } = parsed.data;
  try {
    await confirmRecord(id, table);
    res.json({ ok: true, id, table, confidence: "confirmed" });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// POST /api/records/discard — delete a record by id+table or all records by repo+source
router.post("/discard", async (req, res) => {
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
router.post("/edit", async (req, res) => {
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

// GET /api/records/pending?repo=&service= — all extracted/inferred records awaiting review
router.get("/pending", async (req, res) => {
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : undefined;
  const service = typeof req.query["service"] === "string" ? req.query["service"] : undefined;
  const records = await getPendingRecords(repo, service);
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

export default router;
