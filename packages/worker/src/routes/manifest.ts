import { Router } from "express";
import { z } from "zod";
import { isAbsolute, resolve } from "path";
import {
  generateManifest,
  writeManifest,
  syncToRegistry,
} from "../services/manifest/service.js";
import { inferAllTiers } from "../services/manifest/infer.js";

const router = Router();

const absolutePath = z.string().refine(
  (p) => isAbsolute(p) && resolve(p) === p,
  { message: "cwd must be an absolute, non-traversal path" },
);

const SyncBody = z.object({
  repo: z.string(),
  cwd: absolutePath,
});

// POST /api/manifest/sync
router.post("/sync", async (req, res) => {
  const parsed = SyncBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { repo, cwd } = parsed.data;
  const manifest = await generateManifest(repo, cwd);
  writeManifest(cwd, manifest);
  await syncToRegistry(manifest);
  res.json({
    ok: true,
    repo,
    version: manifest.version,
    exported:
      manifest.exported_decisions.length +
      manifest.exported_deferred.length +
      manifest.exported_risks.length,
    synced_at: manifest.synced_at,
  });
});

// GET /api/manifest/infer?repo=&cwd=
router.get("/infer", async (req, res) => {
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : undefined;
  const cwd = typeof req.query["cwd"] === "string" ? req.query["cwd"] : process.cwd();
  if (!repo) {
    res.status(400).json({ error: "repo query param required" });
    return;
  }
  const inferences = await inferAllTiers(repo, cwd);
  res.json({ repo, inferences, overrides: inferences.filter((i) => i.is_override).length });
});

export default router;
