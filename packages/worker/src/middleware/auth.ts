import type { Request, Response, NextFunction } from "express";
import { validateToken, type Scope } from "../services/auth/service.js";

export interface AuthLocals {
  author: string;
  scopes: Scope[];
}

// Dev mode: all scopes granted when no token is presented and auth is not required
const DEV_AUTH: AuthLocals = {
  author: "dev",
  scopes: ["read", "write:sessions", "write:decisions"],
};

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authRequired = process.env["CLAUDE_LORE_AUTH_REQUIRED"] === "true";
  const header = req.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    if (authRequired) {
      res.status(401).json({ error: "Authorization required — provide Bearer token" });
      return;
    }
    res.locals["auth"] = DEV_AUTH;
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
    const auth = res.locals["auth"] as AuthLocals | undefined;
    if (!auth?.scopes.includes(scope)) {
      res.status(403).json({ error: `Scope '${scope}' required` });
      return;
    }
    next();
  };
}
