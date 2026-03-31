import { randomUUID } from "crypto";
import { personalDb } from "../sqlite/db.js";

/** Escape SQLite LIKE special characters so user-supplied tag values are treated as literals. */
function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export interface GlobalMemory {
  id: string;
  content: string;
  tags: string | null;
  injected: number;
  created_at: number;
  updated_at: number;
}

export async function addMemory(content: string, tags?: string): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await personalDb.execute({
    sql: `INSERT INTO global_memory (id, content, tags, injected, created_at, updated_at)
          VALUES (?, ?, ?, 1, ?, ?)`,
    args: [id, content, tags ?? null, now, now],
  });
  return id;
}

export async function listMemories(opts: { tag?: string; injectedOnly?: boolean } = {}): Promise<GlobalMemory[]> {
  let sql = `SELECT * FROM global_memory`;
  const args: (string | number)[] = [];
  const conditions: string[] = [];

  if (opts.tag) {
    // Match exact tag or tag within comma-separated list.
    // Escape LIKE wildcards so tag values are treated as literals.
    const safe = escapeLike(opts.tag);
    conditions.push(`(tags = ? OR tags LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')`);
    args.push(opts.tag, `${safe},%`, `%,${safe}`, `%,${safe},%`);
  }
  if (opts.injectedOnly) {
    conditions.push(`injected = 1`);
  }
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }
  sql += ` ORDER BY created_at DESC`;

  const res = await personalDb.execute({ sql, args });
  return res.rows.map((r) => ({
    id: String(r["id"]),
    content: String(r["content"]),
    tags: r["tags"] != null ? String(r["tags"]) : null,
    injected: Number(r["injected"]),
    created_at: Number(r["created_at"]),
    updated_at: Number(r["updated_at"]),
  }));
}

export async function deleteMemory(id: string): Promise<boolean> {
  // Support short-id prefix matching (e.g. first 8 chars of UUID)
  const res = await personalDb.execute({
    sql: `DELETE FROM global_memory WHERE id = ? OR id LIKE ?`,
    args: [id, `${id}%`],
  });
  return (res.rowsAffected ?? 0) > 0;
}

export async function deleteMemoriesByTag(tag: string): Promise<number> {
  const safe = escapeLike(tag);
  const res = await personalDb.execute({
    sql: `DELETE FROM global_memory
          WHERE tags = ? OR tags LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'`,
    args: [tag, `${safe},%`, `%,${safe}`, `%,${safe},%`],
  });
  return res.rowsAffected ?? 0;
}

export async function setInjected(id: string, injected: boolean): Promise<boolean> {
  const now = Date.now();
  // Support short-id prefix matching
  const res = await personalDb.execute({
    sql: `UPDATE global_memory SET injected = ?, updated_at = ? WHERE id = ? OR id LIKE ?`,
    args: [injected ? 1 : 0, now, id, `${id}%`],
  });
  return (res.rowsAffected ?? 0) > 0;
}

export async function getInjectableMemories(): Promise<GlobalMemory[]> {
  // Limit at DB level to cap context injection size regardless of how many memories exist
  const res = await personalDb.execute({
    sql: `SELECT * FROM global_memory WHERE injected = 1 ORDER BY created_at DESC LIMIT 50`,
    args: [],
  });
  return res.rows.map((r) => ({
    id: String(r["id"]),
    content: String(r["content"]),
    tags: r["tags"] != null ? String(r["tags"]) : null,
    injected: Number(r["injected"]),
    created_at: Number(r["created_at"]),
    updated_at: Number(r["updated_at"]),
  }));
}
