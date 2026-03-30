import { Router } from "express";
import { z } from "zod";
import { requireScope } from "../middleware/auth.js";
import {
  runSync,
  getSyncStatus,
  getSyncConflicts,
  resolveConflict,
} from "../services/sync/service.js";

const router = Router();

// GET /api/sync/status — last sync result + unresolved conflicts count
router.get("/status", async (_req, res) => {
  try {
    const status = await getSyncStatus();
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/sync/now — trigger an immediate sync
router.post("/now", requireScope("write:sessions"), async (_req, res) => {
  try {
    const entry = await runSync();
    res.json({ ok: entry.status !== "failed", entry });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/sync/conflicts?repo= — list unresolved conflicts
router.get("/conflicts", async (req, res) => {
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : undefined;
  try {
    const conflicts = await getSyncConflicts(repo);
    res.json({ ok: true, conflicts, count: conflicts.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/sync/conflicts/:id/resolve — mark a conflict as resolved
const ResolveBody = z.object({ id: z.string() });

router.post("/conflicts/:id/resolve", requireScope("write:decisions"), async (req, res) => {
  const parsed = ResolveBody.safeParse({ id: req.params["id"] });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    await resolveConflict(parsed.data.id);
    res.json({ ok: true, id: parsed.data.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
