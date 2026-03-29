import { Router } from "express";
import { z } from "zod";
import { isAbsolute, resolve } from "path";
import { generateCoverageReport } from "../services/coverage/service.js";

const router = Router();

const absolutePath = z.string().refine(
  (p) => isAbsolute(p) && resolve(p) === p,
  { message: "cwd must be an absolute, non-traversal path" },
);

const GenerateBody = z.object({
  repo: z.string(),
  cwd: absolutePath,
});

// POST /api/coverage/generate
router.post("/generate", async (req, res) => {
  const parsed = GenerateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { repo, cwd } = parsed.data;
  const report = await generateCoverageReport(repo, cwd);
  res.json({
    ok: true,
    repo,
    generated_at: report.generated_at,
    manifest_path: `${cwd}/.codegraph/coverage-report.md`,
    summary: {
      high_caller_without_adr: report.high_caller_symbols_without_adr.length,
      orphaned_anchors: report.orphaned_anchors.length,
      stale_inferred: report.stale_inferred.length,
      stale_deferred: report.stale_deferred.length,
      structural_db_present: report.structural_db_present,
    },
  });
});

export default router;
