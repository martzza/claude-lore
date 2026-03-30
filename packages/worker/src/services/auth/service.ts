import { randomBytes, timingSafeEqual } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG_PATH = join(homedir(), ".codegraph", "config.json");

export const VALID_SCOPES = ["read", "write:sessions", "write:decisions"] as const;
export type Scope = (typeof VALID_SCOPES)[number];

export interface TokenRecord {
  token: string;
  author: string;
  scopes: Scope[];
  created_at: number;
}

interface Config {
  tokens: TokenRecord[];
}

function readConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return { tokens: [] };
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
  } catch {
    return { tokens: [] };
  }
}

function writeConfig(config: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function generateToken(author: string, scopes: Scope[]): string {
  const token = randomBytes(32).toString("hex");
  const config = readConfig();
  config.tokens.push({ token, author, scopes, created_at: Date.now() });
  writeConfig(config);
  return token;
}

export function validateToken(token: string): TokenRecord | null {
  const config = readConfig();
  const incoming = Buffer.from(token);
  for (const t of config.tokens) {
    const stored = Buffer.from(t.token);
    if (stored.length === incoming.length && timingSafeEqual(stored, incoming)) {
      return t;
    }
  }
  return null;
}

export function listTokens(): Array<{ masked: string; author: string; scopes: Scope[]; created_at: number }> {
  return readConfig().tokens.map((t) => ({
    masked: `${t.token.slice(0, 8)}...${t.token.slice(-8)}`,
    author: t.author,
    scopes: t.scopes,
    created_at: t.created_at,
  }));
}

export function revokeToken(token: string): boolean {
  const config = readConfig();
  const before = config.tokens.length;
  config.tokens = config.tokens.filter((t) => t.token !== token);
  if (config.tokens.length < before) {
    writeConfig(config);
    return true;
  }
  return false;
}
