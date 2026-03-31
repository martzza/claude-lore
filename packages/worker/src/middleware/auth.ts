import type { Request, Response, NextFunction } from "express";
import { validateToken, getMode, type Scope } from "../services/auth/service.js";

export interface AuthLocals {
  author: string;
  scopes: Scope[];
}

// All scopes granted — used in solo mode and when no token is presented in dev
const FULL_AUTH: AuthLocals = {
  author: "dev",
  scopes: ["read", "write:sessions", "write:decisions"],
};

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const mode = getMode();
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    // Team mode: require a token by default. Opt out with CLAUDE_LORE_AUTH_REQUIRED=false
    // (e.g. in a dev container where the network is already trusted).
    // Solo mode: no token required — grant full access (localhost-only assumption).
    if (mode === "team" && process.env["CLAUDE_LORE_AUTH_REQUIRED"] !== "false") {
      res.status(401).json({ error: "Authorization required — provide Bearer token" });
      return;
    }
    res.locals["auth"] = FULL_AUTH;
    next();
    return;
  }

  const token = header.slice(7).trim();
  const record = validateToken(token);
  if (!record) {
    res.status(401).json({ error: "Invalid or revoked token" });
    return;
  }

  res.locals["auth"] = { author: record.author, scopes: record.scopes } satisfies AuthLocals;
  next();
}

export function requireScope(scope: Scope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Solo mode: all scopes implicitly granted — no token management needed
    if (getMode() === "solo") {
      next();
      return;
    }
    const auth = res.locals["auth"] as AuthLocals | undefined;
    if (!auth?.scopes.includes(scope)) {
      res.status(403).json({ error: `Scope '${scope}' required` });
      return;
    }
    next();
  };
}
