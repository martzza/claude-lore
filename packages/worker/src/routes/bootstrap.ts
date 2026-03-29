import { Router } from "express";
import { z } from "zod";
import { runBootstrap, deduplicateBootstrapRecords } from "../services/bootstrap/bootstrap.js";
import { runImport } from "../services/bootstrap/importer.js";
import { listTemplates } from "../services/bootstrap/registry.js";
import { requireScope } from "../middleware/auth.js";

const router = Router();

const RunBody = z.object({
  repo: z.string(),
  templateIds: z.array(z.string()).optional(),
  dryRun: z.boolean().optional().default(false),
});

// POST /api/bootstrap/run
router.post("/run", requireScope("write:sessions"), async (req, res) => {
  const parsed = RunBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const results = await runBootstrap(parsed.data);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// POST /api/bootstrap/import
const ImportBody = z.object({
  repo: z.string(),
  path: z.string().optional(),
  file: z.string().optional(),
  dryRun: z.boolean().optional().default(false),
});

router.post("/import", requireScope("write:sessions"), async (req, res) => {
  const parsed = ImportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const result = await runImport(parsed.data);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// POST /api/bootstrap/dedup — remove duplicate records (same repo+content), keep oldest per group
const DedupBody = z.object({ repo: z.string() });

router.post("/dedup", requireScope("write:sessions"), async (req, res) => {
  const parsed = DedupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const deleted = await deduplicateBootstrapRecords(parsed.data.repo);
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// GET /api/bootstrap/templates?repo=&includeHidden=true
router.get("/templates", async (req, res) => {
  const repo =
    typeof req.query["repo"] === "string" ? req.query["repo"] : process.cwd();
  const includeHidden = req.query["includeHidden"] === "true";
  const templates = await listTemplates(repo, includeHidden);
  res.json({
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      version: t.version,
      hidden: t.hidden ?? false,
    })),
  });
});

export default router;
