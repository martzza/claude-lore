import { Router } from "express";
import { z } from "zod";
import {
  generateToken,
  listTokens,
  revokeToken,
  VALID_SCOPES,
} from "../services/auth/service.js";

const router = Router();

const GenerateBody = z.object({
  author: z.string().min(1),
  scopes: z.array(z.enum(VALID_SCOPES)).default(["read", "write:sessions", "write:decisions"]),
});

// POST /api/auth/generate — no auth required (bootstrap)
router.post("/generate", (req, res) => {
  const parsed = GenerateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { author, scopes } = parsed.data;
  const token = generateToken(author, scopes);
  res.json({ ok: true, token, author, scopes });
});

// GET /api/auth/tokens
router.get("/tokens", (_req, res) => {
  res.json({ tokens: listTokens() });
});

const RevokeBody = z.object({ token: z.string().min(1) });

// DELETE /api/auth/revoke
router.delete("/revoke", (req, res) => {
  const parsed = RevokeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const removed = revokeToken(parsed.data.token);
  res.json({ ok: removed, removed });
});

export default router;
