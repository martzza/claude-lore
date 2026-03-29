import { Router } from "express";
import { z } from "zod";
import { isAbsolute, resolve } from "path";
import { buildContextString } from "../services/context/service.js";

const router = Router();

const absolutePath = z.string().refine(
  (p) => isAbsolute(p) && resolve(p) === p,
  { message: "cwd must be an absolute, non-traversal path" },
);

const InjectQuery = z.object({
  repo: z.string(),
  cwd: absolutePath.optional(),
});

// GET /api/context/inject?repo=<path>&cwd=<abs> — called by SessionStart hook
router.get("/inject", async (req, res) => {
  const parsed = InjectQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { repo, cwd } = parsed.data;
  const context = await buildContextString(repo, cwd);
  res.json({ context });
});

export default router;
