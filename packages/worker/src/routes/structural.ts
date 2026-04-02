import { Router } from "express";
import { join } from "path";
import { isAbsolute, resolve } from "path";
import { existsSync } from "fs";
import { createClient } from "@libsql/client";
import { buildIndex, getIndexStats, isIndexStale } from "../services/structural/indexer.js";

const router = Router();

// ---------------------------------------------------------------------------
// Helper: open structural.db for a given cwd
// ---------------------------------------------------------------------------

function openDb(cwd: string): ReturnType<typeof createClient> | null {
  const dbPath = join(cwd, ".codegraph", "structural.db");
  if (!existsSync(dbPath)) return null;
  return createClient({ url: "file:" + dbPath });
}

// ---------------------------------------------------------------------------
// POST /api/structural/index
// ---------------------------------------------------------------------------

router.post("/index", async (req, res) => {
  const { repo, cwd, force } = req.body as { repo?: string; cwd?: string; force?: boolean };

  if (!cwd || !isAbsolute(cwd) || resolve(cwd) !== cwd) {
    res.status(400).json({ error: "cwd must be an absolute, non-traversal path" });
    return;
  }

  try {
    const result = await buildIndex(repo ?? cwd, cwd, force ?? false);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/structural/stats?cwd=&repo=
// ---------------------------------------------------------------------------

router.get("/stats", async (req, res) => {
  const cwd  = String(req.query["cwd"]  ?? "");
  const repo = String(req.query["repo"] ?? cwd);

  if (!cwd || !isAbsolute(cwd) || resolve(cwd) !== cwd) {
    res.status(400).json({ error: "cwd must be absolute" });
    return;
  }

  try {
    const stats = await getIndexStats(repo, cwd);
    res.json(stats ?? { indexed: false });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/structural/stale?cwd=&repo=
// ---------------------------------------------------------------------------

router.get("/stale", async (req, res) => {
  const cwd  = String(req.query["cwd"]  ?? "");
  const repo = String(req.query["repo"] ?? cwd);

  if (!cwd || !isAbsolute(cwd) || resolve(cwd) !== cwd) {
    res.status(400).json({ error: "cwd must be absolute" });
    return;
  }

  try {
    const stale = await isIndexStale(repo, cwd);
    res.json({ stale });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/structural/search?q=&cwd=&repo=
// ---------------------------------------------------------------------------

router.get("/search", async (req, res) => {
  const q    = String(req.query["q"]    ?? "");
  const cwd  = String(req.query["cwd"]  ?? "");
  const repo = String(req.query["repo"] ?? cwd); // eslint-disable-line @typescript-eslint/no-unused-vars

  if (!cwd || !isAbsolute(cwd) || resolve(cwd) !== cwd) {
    res.status(400).json({ error: "cwd must be absolute" });
    return;
  }
  if (!q) {
    res.status(400).json({ error: "q is required" });
    return;
  }

  const db = openDb(cwd);
  if (!db) {
    res.status(404).json({ error: "structural index not built", hint: "Run: claude-lore index" });
    return;
  }

  try {
    const result = await db.execute({
      sql: `SELECT name, file, start_line, end_line, kind, exported FROM symbols
            WHERE name LIKE '%' || ? || '%'
            ORDER BY
              CASE WHEN name = ? THEN 0
                   WHEN name LIKE ? || '%' THEN 1
                   ELSE 2 END,
              exported DESC,
              LENGTH(name) ASC
            LIMIT 20`,
      args: [q, q, q],
    });

    res.json({
      query:   q,
      matches: result.rows.map((r) => ({
        name:       String(r["name"]),
        file:       String(r["file"]),
        start_line: Number(r["start_line"]),
        end_line:   Number(r["end_line"]),
        kind:       String(r["kind"]),
        exported:   Number(r["exported"]) === 1,
      })),
      total: result.rows.length,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/structural/callers?symbol=&cwd=
// ---------------------------------------------------------------------------

router.get("/callers", async (req, res) => {
  const symbol = String(req.query["symbol"] ?? "");
  const cwd    = String(req.query["cwd"]    ?? "");

  if (!cwd || !isAbsolute(cwd) || resolve(cwd) !== cwd) {
    res.status(400).json({ error: "cwd must be absolute" });
    return;
  }
  if (!symbol) {
    res.status(400).json({ error: "symbol is required" });
    return;
  }

  const db = openDb(cwd);
  if (!db) {
    res.status(404).json({ error: "structural index not built", hint: "Run: claude-lore index" });
    return;
  }

  try {
    const result = await db.execute({
      sql: `SELECT DISTINCT cg.caller, cg.caller_file, cg.weight,
                   s.start_line, s.kind, s.exported
            FROM call_graph cg
            LEFT JOIN symbols s ON s.name = cg.caller AND s.file = cg.caller_file
            WHERE cg.callee = ?
            ORDER BY cg.weight DESC
            LIMIT 50`,
      args: [symbol],
    });

    res.json({
      symbol,
      callers: result.rows.map((r) => ({
        name:   String(r["caller"]),
        file:   String(r["caller_file"] ?? ""),
        line:   r["start_line"] !== null ? Number(r["start_line"]) : null,
        weight: Number(r["weight"] ?? 1),
        kind:   r["kind"] !== null ? String(r["kind"]) : null,
      })),
      total_callers: result.rows.length,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/structural/callees?symbol=&cwd=
// ---------------------------------------------------------------------------

router.get("/callees", async (req, res) => {
  const symbol = String(req.query["symbol"] ?? "");
  const cwd    = String(req.query["cwd"]    ?? "");

  if (!cwd || !isAbsolute(cwd) || resolve(cwd) !== cwd) {
    res.status(400).json({ error: "cwd must be absolute" });
    return;
  }
  if (!symbol) {
    res.status(400).json({ error: "symbol is required" });
    return;
  }

  const db = openDb(cwd);
  if (!db) {
    res.status(404).json({ error: "structural index not built", hint: "Run: claude-lore index" });
    return;
  }

  try {
    const result = await db.execute({
      sql: `SELECT DISTINCT cg.callee, cg.callee_file, cg.weight,
                   s.start_line, s.kind
            FROM call_graph cg
            LEFT JOIN symbols s ON s.name = cg.callee AND s.file = cg.callee_file
            WHERE cg.caller = ?
            ORDER BY cg.weight DESC
            LIMIT 50`,
      args: [symbol],
    });

    res.json({
      symbol,
      callees: result.rows.map((r) => ({
        name:   String(r["callee"]),
        file:   r["callee_file"] !== null ? String(r["callee_file"]) : null,
        line:   r["start_line"] !== null ? Number(r["start_line"]) : null,
        weight: Number(r["weight"] ?? 1),
        kind:   r["kind"] !== null ? String(r["kind"]) : null,
      })),
      total_callees: result.rows.length,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/structural/impact?symbol=&cwd=&hops=
// ---------------------------------------------------------------------------

router.get("/impact", async (req, res) => {
  const symbol  = String(req.query["symbol"] ?? "");
  const cwd     = String(req.query["cwd"]    ?? "");
  const maxHops = Math.min(parseInt(String(req.query["hops"] ?? "3"), 10), 5);

  if (!cwd || !isAbsolute(cwd) || resolve(cwd) !== cwd) {
    res.status(400).json({ error: "cwd must be absolute" });
    return;
  }
  if (!symbol) {
    res.status(400).json({ error: "symbol is required" });
    return;
  }

  const db = openDb(cwd);
  if (!db) {
    res.status(404).json({ error: "structural index not built", hint: "Run: claude-lore index" });
    return;
  }

  try {
    interface ImpactNode {
      name:   string;
      file:   string;
      hop:    number;
      path:   string[];
      weight: number;
    }

    const visited = new Set<string>([symbol]);
    const results: ImpactNode[] = [];
    let queue: Array<{ name: string; path: string[] }> = [{ name: symbol, path: [symbol] }];

    for (let hop = 1; hop <= maxHops && queue.length > 0; hop++) {
      const names = queue.map((q) => q.name);
      const placeholders = names.map(() => "?").join(",");

      const bfsRes = await db.execute({
        sql: `SELECT DISTINCT cg.caller, cg.caller_file, cg.weight, cg.callee
              FROM call_graph cg
              WHERE cg.callee IN (${placeholders})`,
        args: names,
      });

      const parentMap = new Map<string, { name: string; path: string[] }>();
      for (const qItem of queue) {
        parentMap.set(qItem.name, qItem);
      }

      const nextQueue: Array<{ name: string; path: string[] }> = [];

      for (const row of bfsRes.rows) {
        const caller = String(row["caller"]);
        if (visited.has(caller)) continue;
        visited.add(caller);

        const callee = String(row["callee"]);
        const parent = parentMap.get(callee) ?? queue[0]!;
        const nodePath = [...parent.path, caller];

        results.push({
          name:   caller,
          file:   String(row["caller_file"] ?? ""),
          hop,
          path:   nodePath,
          weight: Number(row["weight"] ?? 1),
        });

        nextQueue.push({ name: caller, path: nodePath });
      }

      queue = nextQueue;
    }

    res.json({
      symbol,
      total_affected:   results.length,
      max_hops_reached: results.length > 0 ? Math.max(...results.map((r) => r.hop)) : 0,
      impact:           results,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
