import { Router } from "express";
import { z } from "zod";
import { isAbsolute, resolve } from "path";
import { checkStaleness, getStalenessReport } from "../services/staleness/service.js";

const router = Router();

const absolutePath = z.string().refine(
  (p) => isAbsolute(p) && resolve(p) === p,
  { message: "cwd must be an absolute, non-traversal path" },
);

const CheckBody = z.object({
  repo: z.string(),
  cwd: absolutePath,
});

// POST /api/staleness/check
router.post("/check", async (req, res) => {
  const parsed = CheckBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const report = await checkStaleness(parsed.data.repo, parsed.data.cwd);
  res.json(report);
});

// GET /api/staleness/report?repo=
router.get("/report", async (req, res) => {
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : undefined;
  if (!repo) {
    res.status(400).json({ error: "repo query param required" });
    return;
  }
  const report = await getStalenessReport(repo);
  res.json(report);
});

export default router;
