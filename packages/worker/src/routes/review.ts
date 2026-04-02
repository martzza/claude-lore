import { Router } from "express";
import { writeFileSync } from "fs";
import { join, isAbsolute, resolve } from "path";
import { tmpdir } from "os";
import { buildDepGraph, enrichDepGraph } from "../services/review/deps.js";
import { getCachedGraph, setCachedGraph, invalidateCache } from "../services/review/cache.js";
import { renderCodebaseMap } from "../services/review/renderers/map.js";
import { renderPropagationView } from "../services/review/renderers/propagation.js";
import { buildReview, renderReviewHtml, getGitDiff } from "../services/review/renderers/review.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/review/deps?repo=&cwd=&format=json|html
// ---------------------------------------------------------------------------

router.get("/deps", async (req, res) => {
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : null;
  const cwd = typeof req.query["cwd"] === "string" ? req.query["cwd"] : repo;
  const format = typeof req.query["format"] === "string" ? req.query["format"] : "json";

  if (!repo || !cwd) {
    res.status(400).json({ error: "repo and cwd query params required" });
    return;
  }
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) {
    res.status(400).json({ error: "cwd must be an absolute, non-traversal path" });
    return;
  }

  try {
    let graph = getCachedGraph(cwd);
    if (!graph) {
      graph = await buildDepGraph(repo, cwd);
      setCachedGraph(cwd, graph);
    }

    if (format === "html") {
      const enriched = await enrichDepGraph(graph, repo);
      const html = renderCodebaseMap(enriched, repo);
      res.setHeader("Content-Type", "text/html");
      res.send(html);
      return;
    }

    res.json({
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      entry_points: graph.entry_points,
      node_list: graph.nodes.map((n) => ({
        path: n.path,
        depth: n.depth,
        dep_count: n.deps.length,
        dependent_count: n.dependents.length,
        size_bytes: n.size_bytes,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/review/map?repo=&cwd=&format=mermaid|html&layout=force|radial
// ---------------------------------------------------------------------------

router.get("/map", async (req, res) => {
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : null;
  const cwd = typeof req.query["cwd"] === "string" ? req.query["cwd"] : repo;
  const format = typeof req.query["format"] === "string" ? req.query["format"] : "html";
  const layout = (req.query["layout"] as "force" | "radial") ?? "force";

  if (!repo || !cwd) {
    res.status(400).json({ error: "repo and cwd query params required" });
    return;
  }
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) {
    res.status(400).json({ error: "cwd must be an absolute, non-traversal path" });
    return;
  }

  try {
    let graph = getCachedGraph(cwd);
    if (!graph) {
      graph = await buildDepGraph(repo, cwd);
      setCachedGraph(cwd, graph);
    }

    const enriched = await enrichDepGraph(graph, repo);

    if (format === "mermaid") {
      const lines = ["graph LR"];
      for (const edge of enriched.edges.slice(0, 50)) {
        const from = edge.from.replace(/[^a-zA-Z0-9_]/g, "_");
        const to = edge.to.replace(/[^a-zA-Z0-9_]/g, "_");
        lines.push(`  ${from} --> ${to}`);
      }
      res.setHeader("Content-Type", "text/plain");
      res.send(lines.join("\n"));
      return;
    }

    const html = renderCodebaseMap(enriched, repo, layout);
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/review/propagation?repo=&cwd=&file=&format=html
// ---------------------------------------------------------------------------

router.get("/propagation", async (req, res) => {
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : null;
  const cwd = typeof req.query["cwd"] === "string" ? req.query["cwd"] : repo;
  const file = typeof req.query["file"] === "string" ? req.query["file"] : null;
  const format = typeof req.query["format"] === "string" ? req.query["format"] : "html";

  if (!repo || !cwd || !file) {
    res.status(400).json({ error: "repo, cwd, and file query params required" });
    return;
  }
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) {
    res.status(400).json({ error: "cwd must be an absolute, non-traversal path" });
    return;
  }

  try {
    let graph = getCachedGraph(cwd);
    if (!graph) {
      graph = await buildDepGraph(repo, cwd);
      setCachedGraph(cwd, graph);
    }

    const enriched = await enrichDepGraph(graph, repo);

    if (format === "json") {
      const affected = new Set<string>([file]);
      const queue = [file];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        const node = enriched.nodes.find((n) => n.path === cur);
        if (!node) continue;
        for (const dep of node.dependents) {
          if (!affected.has(dep)) { affected.add(dep); queue.push(dep); }
        }
      }
      res.json({ focus: file, affected: Array.from(affected), count: affected.size });
      return;
    }

    const html = renderPropagationView(enriched, file, repo);
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/review/diff?repo=&cwd=&base=HEAD&format=json|html
// ---------------------------------------------------------------------------

router.get("/diff", async (req, res) => {
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : null;
  const cwd = typeof req.query["cwd"] === "string" ? req.query["cwd"] : repo;
  const base = typeof req.query["base"] === "string" ? req.query["base"] : "HEAD";
  const format = typeof req.query["format"] === "string" ? req.query["format"] : "html";

  if (!repo || !cwd) {
    res.status(400).json({ error: "repo and cwd query params required" });
    return;
  }
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) {
    res.status(400).json({ error: "cwd must be an absolute, non-traversal path" });
    return;
  }

  try {
    if (format === "json") {
      const diffs = getGitDiff(cwd, base);
      res.json({
        base,
        files: diffs.map((d) => ({
          path: d.path,
          status: d.status,
          lines_added: d.lines_added,
          lines_removed: d.lines_removed,
        })),
      });
      return;
    }

    const reviews = await buildReview(cwd, repo, base);
    const html = renderReviewHtml(reviews, cwd, base);
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/review/invalidate { cwd }
// ---------------------------------------------------------------------------

router.post("/invalidate", (req, res) => {
  const cwd = typeof req.body?.["cwd"] === "string" ? req.body["cwd"] : null;
  if (!cwd) {
    res.status(400).json({ error: "cwd required" });
    return;
  }
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) {
    res.status(400).json({ error: "cwd must be an absolute, non-traversal path" });
    return;
  }
  invalidateCache(cwd);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/review/open?repo=&cwd=&view=map|propagation|diff&file=&base=&format=html
// Open HTML in browser by writing to /tmp
// ---------------------------------------------------------------------------

router.get("/open", async (req, res) => {
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : null;
  const cwd = typeof req.query["cwd"] === "string" ? req.query["cwd"] : repo;
  const view = typeof req.query["view"] === "string" ? req.query["view"] : "map";
  const file = typeof req.query["file"] === "string" ? req.query["file"] : undefined;
  const base = typeof req.query["base"] === "string" ? req.query["base"] : "HEAD";

  if (!repo || !cwd) {
    res.status(400).json({ error: "repo and cwd query params required" });
    return;
  }
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) {
    res.status(400).json({ error: "cwd must be an absolute, non-traversal path" });
    return;
  }

  try {
    let html = "";
    let filename = "";

    if (view === "propagation" && file) {
      let graph = getCachedGraph(cwd);
      if (!graph) { graph = await buildDepGraph(repo, cwd); setCachedGraph(cwd, graph); }
      const enriched = await enrichDepGraph(graph, repo);
      html = renderPropagationView(enriched, file, repo);
      filename = "claude-lore-propagation.html";
    } else if (view === "diff") {
      const reviews = await buildReview(cwd, repo, base);
      html = renderReviewHtml(reviews, cwd, base);
      filename = "claude-lore-review.html";
    } else {
      let graph = getCachedGraph(cwd);
      if (!graph) { graph = await buildDepGraph(repo, cwd); setCachedGraph(cwd, graph); }
      const enriched = await enrichDepGraph(graph, repo);
      html = renderCodebaseMap(enriched, repo);
      filename = "claude-lore-map.html";
    }

    const outPath = join(tmpdir(), filename);
    writeFileSync(outPath, html, "utf8");
    res.json({ ok: true, path: outPath });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
