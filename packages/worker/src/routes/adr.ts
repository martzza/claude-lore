import { Router } from "express";
import { z } from "zod";
import { execSync } from "child_process";
import {
  getAdrCandidates,
  createDraftAdr,
  confirmAdr,
  discardAdr,
  formatAdrComment,
  postAdrComment,
} from "../services/adr/service.js";
import { requireScope } from "../middleware/auth.js";
import type { AuthLocals } from "../middleware/auth.js";

const router = Router();

const IdBody = z.object({ id: z.string().uuid() });
const RepoBody = z.object({ repo: z.string().optional() });

// GET /api/adr/candidates?repo=
router.get("/candidates", async (req, res) => {
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : process.cwd();
  const candidates = await getAdrCandidates(repo);
  res.json({ candidates, count: candidates.length });
});

// POST /api/adr/draft — create a draft ADR
router.post("/draft", requireScope("write:decisions"), async (req, res) => {
  const Body = z.object({
    repo: z.string(),
    title: z.string(),
    content: z.string(),
    rationale: z.string().optional(),
    context: z.string().optional(),
    alternatives: z.string().optional(),
    session_id: z.string().optional(),
  });
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { repo, title, content, rationale, context, alternatives, session_id } = parsed.data;
  const id = await createDraftAdr(repo, title, content, rationale, context, alternatives, session_id);
  res.json({ ok: true, id, adr_status: "draft" });
});

// POST /api/adr/confirm { id }
router.post("/confirm", requireScope("write:decisions"), async (req, res) => {
  const parsed = IdBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { id } = parsed.data;
  const auth = res.locals["auth"] as AuthLocals;
  await confirmAdr(id, auth.author);
  res.json({ ok: true, id, adr_status: "accepted", confidence: "confirmed" });
});

// POST /api/adr/discard { id }
router.post("/discard", requireScope("write:decisions"), async (req, res) => {
  const parsed = IdBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { id } = parsed.data;
  await discardAdr(id);
  res.json({ ok: true, id, adr_status: "superseded" });
});

// POST /api/adr/post-pr { repo } — post all candidates as PR comment(s)
router.post("/post-pr", async (req, res) => {
  const parsed = RepoBody.safeParse(req.body);
  const repo = parsed.success ? (parsed.data.repo ?? process.cwd()) : process.cwd();
  const candidates = await getAdrCandidates(repo);
  const results: Array<{ id: string; title: string; posted: boolean; method: string }> = [];

  for (const adr of candidates) {
    const body = formatAdrComment(adr);
    const { posted, method } = postAdrComment(body);
    if (method === "stdout") {
      // gh not available — print to response body
      console.log("\n" + body);
    }
    results.push({ id: adr.id, title: adr.adr_title, posted, method });
  }

  res.json({ ok: true, count: candidates.length, results });
});

export default router;
