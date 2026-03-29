import { Router } from "express";
import { z } from "zod";
import { isAbsolute, resolve } from "path";
import { analyseKnowledgeGaps } from "../services/advisor/gaps.js";
import { analyseClaudeMd } from "../services/advisor/claudemd.js";
import { analyseSkillGaps } from "../services/advisor/skills.js";
import { analyseParallelism, analyseParallelismFromDeferred } from "../services/advisor/parallel.js";
import { analyseWorkflow } from "../services/advisor/workflow.js";

const router = Router();

const absolutePath = z.string().refine(
  (p) => isAbsolute(p) && resolve(p) === p,
  { message: "cwd must be an absolute, non-traversal path" },
);

const GapsQuery = z.object({
  repo: z.string().min(1),
  cwd: absolutePath,
});

const ClaudeMdQuery = z.object({
  repo: z.string().min(1),
  cwd: absolutePath,
});

const SkillsQuery = z.object({
  repo: z.string().min(1),
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const ParallelBody = z.object({
  repo: z.string().min(1),
  tasks: z.array(z.string().min(1)).min(1).max(50),
});

const ParallelQuery = z.object({
  repo: z.string().min(1),
  tasks: z.string().optional(),   // comma-separated
  from_deferred: z.coerce.boolean().optional(),
});

const WorkflowQuery = z.object({
  repo: z.string().min(1),
  days: z.coerce.number().int().min(1).max(365).default(60),
});

// GET /api/advisor/gaps?repo=&cwd=
router.get("/gaps", async (req, res) => {
  const parsed = GapsQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const advisory = await analyseKnowledgeGaps(parsed.data.repo, parsed.data.cwd);
  res.json(advisory);
});

// GET /api/advisor/claudemd?repo=&cwd=
router.get("/claudemd", async (req, res) => {
  const parsed = ClaudeMdQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const analysis = await analyseClaudeMd(parsed.data.repo, parsed.data.cwd);
  res.json(analysis);
});

// GET /api/advisor/skills?repo=&days=30
router.get("/skills", async (req, res) => {
  const parsed = SkillsQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const analysis = await analyseSkillGaps(parsed.data.repo, parsed.data.days);
  res.json(analysis);
});

// POST /api/advisor/parallel { repo, tasks: string[] }
router.post("/parallel", async (req, res) => {
  const parsed = ParallelBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const analysis = await analyseParallelism(parsed.data.repo, parsed.data.tasks);
  res.json(analysis);
});

// GET /api/advisor/parallel?repo=&tasks=t1,t2 or ?repo=&from_deferred=true
router.get("/parallel", async (req, res) => {
  const parsed = ParallelQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { repo, tasks, from_deferred } = parsed.data;

  let analysis;
  if (from_deferred) {
    analysis = await analyseParallelismFromDeferred(repo);
  } else if (tasks) {
    const taskList = tasks.split(",").map((t) => t.trim()).filter(Boolean);
    analysis = await analyseParallelism(repo, taskList);
  } else {
    analysis = await analyseParallelismFromDeferred(repo);
  }
  res.json(analysis);
});

// GET /api/advisor/workflow?repo=&days=60
router.get("/workflow", async (req, res) => {
  const parsed = WorkflowQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const analysis = await analyseWorkflow(parsed.data.repo, parsed.data.days);
  res.json(analysis);
});

export default router;
