import { Router } from "express";
import { z } from "zod";
import { isAbsolute, resolve } from "path";
import { indexSkills, getSkillConflicts } from "../services/skills/service.js";

const router = Router();

const absolutePath = z.string().refine(
  (p) => isAbsolute(p) && resolve(p) === p,
  { message: "cwd must be an absolute, non-traversal path" },
);

const IndexBody = z.object({
  repo: z.string(),
  cwd: absolutePath,
});

// POST /api/skills/index
router.post("/index", async (req, res) => {
  const parsed = IndexBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const result = await indexSkills(parsed.data.repo, parsed.data.cwd);
  res.json({ ok: true, ...result });
});

// GET /api/skills/conflicts?repo=
router.get("/conflicts", async (req, res) => {
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : undefined;
  if (!repo) {
    res.status(400).json({ error: "repo query param required" });
    return;
  }
  const conflicts = await getSkillConflicts(repo);
  const grouped = {
    missing: conflicts.filter((c) => c.type === "missing"),
    version_drift: conflicts.filter((c) => c.type === "version_drift"),
    orphaned_override: conflicts.filter((c) => c.type === "orphaned_override"),
  };
  res.json({ repo, conflicts: grouped, total: conflicts.length });
});

export default router;
