import { Router } from "express";
import { join, isAbsolute, resolve } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { createClient } from "@libsql/client";
import { buildIndex, getIndexStats, isIndexStale } from "../services/structural/indexer.js";
import { getStructuralClient } from "../services/structural/db-cache.js";
import { startWatch, stopWatch, isWatching } from "../services/structural/watcher.js";
import { generateWiki, renderWikiPageMarkdown, renderWikiIndexMarkdown } from "../services/structural/wiki.js";
import { renderWikiHtml } from "../services/structural/wiki-html.js";
import { getWikiCache, setWikiCache, invalidateWikiCache, WIKI_CACHE_TTL_MS } from "../services/structural/wiki-cache.js";

export { invalidateWikiCache };

const router = Router();

// ---------------------------------------------------------------------------
// Helper: open structural.db for a given cwd
// ---------------------------------------------------------------------------

function openDb(cwd: string) {
  const dbPath = join(cwd, ".codegraph", "structural.db");
  return getStructuralClient(dbPath);
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
    invalidateWikiCache(cwd);
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
  const maxHops = Math.min(Math.max(1, parseInt(String(req.query["hops"] ?? "3"), 10) || 3), 5);

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
      max_hops_reached: results.reduce((m, r) => r.hop > m ? r.hop : m, 0),
      impact:           results,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/structural/watch/start  { repo, cwd }
// POST /api/structural/watch/stop   { repo }
// GET  /api/structural/watch/status?repo=
// ---------------------------------------------------------------------------

router.post("/watch/start", async (req, res) => {
  const { repo, cwd } = req.body as { repo?: string; cwd?: string };

  if (!cwd || !isAbsolute(cwd) || resolve(cwd) !== cwd) {
    res.status(400).json({ error: "cwd must be an absolute, non-traversal path" });
    return;
  }

  const repoName = repo ?? cwd;
  try {
    await startWatch(repoName, cwd);
    res.json({ ok: true, watching: true, repo: repoName });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/watch/stop", async (req, res) => {
  const { repo } = req.body as { repo?: string };
  if (!repo) {
    res.status(400).json({ error: "repo is required" });
    return;
  }
  stopWatch(repo);
  res.json({ ok: true, watching: false, repo });
});

router.get("/watch/status", (req, res) => {
  const repo = String(req.query["repo"] ?? "");
  if (!repo) {
    res.status(400).json({ error: "repo is required" });
    return;
  }
  res.json({ watching: isWatching(repo), repo });
});

// ---------------------------------------------------------------------------
// GET /api/structural/wiki?cwd=&repo=&format=json|markdown&community=
// ---------------------------------------------------------------------------

router.get("/wiki", async (req, res) => {
  const cwd       = String(req.query["cwd"] ?? "");
  const repo      = String(req.query["repo"] ?? cwd);
  const format    = String(req.query["format"] ?? "json");
  const community = String(req.query["community"] ?? "");

  if (!cwd || !isAbsolute(cwd)) {
    res.status(400).json({ error: "cwd must be an absolute path" });
    return;
  }

  const structDbPath  = join(cwd, ".codegraph", "structural.db");
  const sessionsDbPath = join(homedir(), ".codegraph", "sessions.db");

  if (!existsSync(structDbPath)) {
    res.status(404).json({ error: "structural index not built — run claude-lore index" });
    return;
  }

  try {
    // Check shared cache (5 min TTL)
    const cached = getWikiCache(cwd);
    let pages: Awaited<ReturnType<typeof generateWiki>>;

    if (cached && Date.now() - cached.generatedAt < WIKI_CACHE_TTL_MS) {
      pages = cached.pages;
    } else {
      const structDb = createClient({ url: `file:${structDbPath}` });
      const reasonDb = createClient({ url: `file:${sessionsDbPath}` });
      pages = await generateWiki(structDb, reasonDb, repo);
      setWikiCache(cwd, pages);
    }

    // Filter by community if specified
    const filtered = community
      ? pages.filter(p => p.community_name === community || p.community_id === community)
      : pages;

    if (format === "html") {
      res.type("text/html").send(renderWikiHtml(pages));
      return;
    }

    if (format === "markdown") {
      if (community) {
        const page = filtered[0];
        if (!page) {
          res.status(404).json({ error: `community '${community}' not found` });
          return;
        }
        res.type("text/markdown").send(renderWikiPageMarkdown(page));
      } else {
        const index = renderWikiIndexMarkdown(pages);
        const allPages = pages.map(renderWikiPageMarkdown).join("\n\n---\n\n");
        res.type("text/markdown").send(index + "\n\n---\n\n" + allPages);
      }
      return;
    }

    // JSON response
    if (community) {
      const page = filtered[0];
      if (!page) {
        res.status(404).json({ error: `community '${community}' not found` });
        return;
      }
      res.json({ community: page });
    } else {
      res.json({
        communities: pages.length,
        total_symbols: pages.reduce((n, p) => n + p.size, 0),
        generated_at: pages[0]?.generated_at ?? Date.now(),
        pages: filtered,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
