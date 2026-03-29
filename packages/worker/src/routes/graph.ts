import { Router } from "express";
import {
  buildDecisionHierarchy,
  buildSymbolImpactGraph,
  buildPortfolioGraph,
} from "../services/graph/service.js";
import { toMermaid } from "../services/graph/renderers/mermaid.js";
import { toDot } from "../services/graph/renderers/dot.js";
import { toHtml } from "../services/graph/renderers/html.js";

const router = Router();

type Format = "mermaid" | "dot" | "html" | "json";

function parseFormat(raw: unknown): Format {
  if (raw === "dot" || raw === "html" || raw === "json") return raw;
  return "mermaid";
}

function send(res: import("express").Response, format: Format, data: unknown): void {
  const { GraphData: _unused, ..._ } = { GraphData: null };
  const graph = data as import("../services/graph/service.js").GraphData;
  switch (format) {
    case "json":
      res.json(graph);
      return;
    case "mermaid":
      res.type("text/plain").send(toMermaid(graph));
      return;
    case "dot":
      res.type("text/plain").send(toDot(graph));
      return;
    case "html":
      res.type("text/html").send(toHtml(graph));
      return;
  }
}

// GET /api/graph/decisions?repo=&format=mermaid|dot|html|json
router.get("/decisions", async (req, res) => {
  const repo =
    typeof req.query["repo"] === "string" ? req.query["repo"] : process.cwd();
  const format = parseFormat(req.query["format"]);
  try {
    const graph = await buildDecisionHierarchy(repo);
    send(res, format, graph);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/graph/symbol?symbol=&repo=&format=
router.get("/symbol", async (req, res) => {
  const symbol = typeof req.query["symbol"] === "string" ? req.query["symbol"] : null;
  const repo =
    typeof req.query["repo"] === "string" ? req.query["repo"] : process.cwd();
  const format = parseFormat(req.query["format"]);

  if (!symbol) {
    res.status(400).json({ error: "symbol query param required" });
    return;
  }
  try {
    const graph = await buildSymbolImpactGraph(symbol, repo);
    send(res, format, graph);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/graph/portfolio?repos=a,b,c&format=
router.get("/portfolio", async (req, res) => {
  const reposRaw = typeof req.query["repos"] === "string" ? req.query["repos"] : "";
  const repos = reposRaw ? reposRaw.split(",").map((r) => r.trim()).filter(Boolean) : undefined;
  const format = parseFormat(req.query["format"]);
  try {
    const graph = await buildPortfolioGraph(repos);
    send(res, format, graph);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
