import { Router } from "express";
import { z } from "zod";
import { confirmRecord, discardRecord, discardBySource, getPendingRecords } from "../services/reasoning/service.js";
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

// GET /api/records/pending?repo= — all extracted/inferred records awaiting review
router.get("/pending", async (req, res) => {
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : undefined;
  const records = await getPendingRecords(repo);
  res.json({ records, count: records.length, total: records.length });
});

export default router;
