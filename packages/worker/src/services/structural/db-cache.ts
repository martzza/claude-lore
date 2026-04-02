import { createClient } from "@libsql/client";
import { existsSync } from "fs";

// Module-level client cache: db path → open client.
// Prevents a new file handle being opened on every HTTP request / MCP call.
const _cache = new Map<string, ReturnType<typeof createClient>>();

/**
 * Returns a cached @libsql/client for the given structural.db path.
 * Creates and caches a new client on first call; returns the existing one on
 * subsequent calls for the same path.  Returns null when the file is absent.
 */
export function getStructuralClient(dbPath: string): ReturnType<typeof createClient> | null {
  if (!existsSync(dbPath)) return null;
  const cached = _cache.get(dbPath);
  if (cached) return cached;
  const client = createClient({ url: "file:" + dbPath });
  _cache.set(dbPath, client);
  return client;
}
