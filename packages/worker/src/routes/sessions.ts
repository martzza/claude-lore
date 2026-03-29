import { Router } from "express";
import { z } from "zod";
import {
  initSession,
  logObservation,
  completeSession,
} from "../services/sessions/service.js";
import { runCompressionPass } from "../services/compression/service.js";
import { requireScope } from "../middleware/auth.js";

const router = Router();

const InitBody = z.object({
  session_id: z.string(),
  repo: z.string(),
});

const ObservationBody = z.object({
  session_id: z.string(),
  repo: z.string(),
  tool_name: z.string().optional().default("unknown"),
  content: z.string(),
});

const SessionRefBody = z.object({
  session_id: z.string(),
  repo: z.string(),
});

// POST /api/sessions/init — called by SessionStart hook
router.post("/init", requireScope("write:sessions"), async (req, res) => {
  const parsed = InitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { session_id, repo } = parsed.data;
  await initSession(session_id, repo);
  res.json({ ok: true });
});

// POST /api/sessions/observations — called by PostToolUse hook
router.post("/observations", async (req, res) => {
  const parsed = ObservationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { session_id, repo, tool_name, content } = parsed.data;
  await logObservation(session_id, repo, tool_name, content);
  res.json({ ok: true });
});

// POST /api/sessions/summarise — called by Stop hook; triggers AI compression
router.post("/summarise", async (req, res) => {
  const parsed = SessionRefBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { session_id, repo } = parsed.data;
  // Respond immediately, run compression async
  res.json({ ok: true, queued: true });
  runCompressionPass(session_id, repo).catch((err) =>
    console.error("[compression] error:", err),
  );
});

// POST /api/sessions/complete — called by SessionEnd hook
router.post("/complete", async (req, res) => {
  const parsed = SessionRefBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { session_id } = parsed.data;
  // Mark complete only if not already done by the compression pass
  await completeSession(session_id);
  res.json({ ok: true });
});

export default router;
