import { Router } from "express";
import { z } from "zod";
import {
  addMemory,
  listMemories,
  deleteMemory,
  deleteMemoriesByTag,
  setInjected,
} from "../services/memory/service.js";

const router = Router();

const AddBody = z.object({
  content: z.string().min(1),
  tags: z.string().optional(),
});

const SetInjectedBody = z.object({
  injected: z.boolean(),
});

// POST /api/memory — add a global memory
router.post("/", async (req, res) => {
  const parsed = AddBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const id = await addMemory(parsed.data.content, parsed.data.tags);
  res.json({ ok: true, id });
});

// GET /api/memory?tag=<tag>&all=true — list memories
router.get("/", async (req, res) => {
  const tag = typeof req.query["tag"] === "string" ? req.query["tag"] : undefined;
  const all = req.query["all"] === "true";
  const memories = await listMemories({ tag, injectedOnly: !all });
  res.json({ ok: true, memories });
});

// PUT /api/memory/:id — toggle injected flag
router.put("/:id", async (req, res) => {
  const id = req.params["id"];
  if (!id) {
    res.status(400).json({ error: "id required" });
    return;
  }
  const parsed = SetInjectedBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const ok = await setInjected(id, parsed.data.injected);
  res.json({ ok });
});

// DELETE /api/memory?tag=<tag> — bulk delete by tag
router.delete("/", async (req, res) => {
  const tag = typeof req.query["tag"] === "string" ? req.query["tag"] : undefined;
  if (!tag) {
    res.status(400).json({ error: "tag query param required for bulk delete" });
    return;
  }
  const count = await deleteMemoriesByTag(tag);
  res.json({ ok: true, deleted: count });
});

// DELETE /api/memory/:id — delete single memory
router.delete("/:id", async (req, res) => {
  const id = req.params["id"];
  if (!id) {
    res.status(400).json({ error: "id required" });
    return;
  }
  const ok = await deleteMemory(id);
  res.json({ ok });
});

export default router;
