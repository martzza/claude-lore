import { Router } from "express";
import { existsSync, readFileSync } from "fs";
import { isAbsolute } from "path";
import {
  getAnnotationsForFile,
  getAnnotationCoverage,
  getSymbolLocations,
} from "../services/annotation/mapper.js";
import { renderAnnotatedSource } from "../services/annotation/renderer.js";
import { buildProvenance, formatProvenanceText, formatProvenanceMermaid, formatProvenanceHtml } from "../services/annotation/provenance.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/annotation/file?path=&repo=&format=html|json
// ---------------------------------------------------------------------------

router.get("/file", async (req, res) => {
  const filePath = typeof req.query["path"] === "string" ? req.query["path"] : null;
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : process.cwd();
  const format = req.query["format"] === "json" ? "json" : "html";

  if (!filePath) {
    res.status(400).json({ error: "path query param required" });
    return;
  }
  if (!isAbsolute(filePath)) {
    res.status(400).json({ error: "path must be absolute" });
    return;
  }
  if (!existsSync(filePath)) {
    res.status(404).json({ error: `file not found: ${filePath}` });
    return;
  }

  try {
    const fileContent = readFileSync(filePath, "utf8");
    const annotations = await getAnnotationsForFile(filePath, repo);

    if (format === "json") {
      res.json({ file: filePath, repo, annotations });
      return;
    }

    const html = renderAnnotatedSource(filePath, fileContent, annotations, repo);
    res.type("text/html").send(html);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/annotation/provenance?symbol=&repo=&format=text|html|mermaid|json
// ---------------------------------------------------------------------------

router.get("/provenance", async (req, res) => {
  const symbol = typeof req.query["symbol"] === "string" ? req.query["symbol"] : null;
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : process.cwd();
  const format = (req.query["format"] as string) ?? "text";

  if (!symbol) {
    res.status(400).json({ error: "symbol query param required" });
    return;
  }

  try {
    const trace = await buildProvenance(symbol, repo);

    switch (format) {
      case "json":
        res.json(trace);
        return;
      case "mermaid":
        res.type("text/plain").send(formatProvenanceMermaid(trace));
        return;
      case "html":
        res.type("text/html").send(formatProvenanceHtml(trace));
        return;
      default:
        res.type("text/plain").send(formatProvenanceText(trace));
        return;
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/annotation/coverage?repo=&cwd=
// ---------------------------------------------------------------------------

router.get("/coverage", async (req, res) => {
  const repo = typeof req.query["repo"] === "string" ? req.query["repo"] : process.cwd();
  const cwd = typeof req.query["cwd"] === "string" ? req.query["cwd"] : repo;

  try {
    // Discover TS/JS/Go/Py source files in cwd (shallow scan, 2 levels deep)
    const { readdirSync, statSync } = await import("fs");
    const { join } = await import("path");

    const srcExts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".go"]);
    const ignoreDirs = new Set(["node_modules", ".git", "dist", "build", ".codegraph"]);

    function scanDir(dir: string, depth: number): string[] {
      if (depth > 3) return [];
      let files: string[] = [];
      try {
        for (const entry of readdirSync(dir)) {
          if (ignoreDirs.has(entry)) continue;
          const full = join(dir, entry);
          try {
            const stat = statSync(full);
            if (stat.isDirectory()) {
              files = files.concat(scanDir(full, depth + 1));
            } else if (srcExts.has(join(".", entry).slice(1) as string)) {
              // use extname check
              const ext = entry.slice(entry.lastIndexOf("."));
              if (srcExts.has(ext)) files.push(full);
            }
          } catch { /* skip unreadable */ }
        }
      } catch { /* skip unreadable dir */ }
      return files;
    }

    // Filter by extension more reliably
    function collectFiles(dir: string, depth: number): string[] {
      if (depth > 3) return [];
      let files: string[] = [];
      try {
        for (const entry of readdirSync(dir)) {
          if (ignoreDirs.has(entry)) continue;
          const full = join(dir, entry);
          try {
            const stat = statSync(full);
            if (stat.isDirectory()) {
              files = files.concat(collectFiles(full, depth + 1));
            } else {
              const dot = entry.lastIndexOf(".");
              if (dot >= 0 && srcExts.has(entry.slice(dot))) files.push(full);
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
      return files;
    }

    const filePaths = collectFiles(cwd, 0);
    const stats = await getAnnotationCoverage(filePaths, repo);
    res.json({ ...stats, repo, cwd, files_scanned: filePaths.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/annotation/symbols?path=
// (helper: list symbols found in a file — useful for testing the mapper)
// ---------------------------------------------------------------------------

router.get("/symbols", (req, res) => {
  const filePath = typeof req.query["path"] === "string" ? req.query["path"] : null;
  if (!filePath || !isAbsolute(filePath)) {
    res.status(400).json({ error: "absolute path query param required" });
    return;
  }
  try {
    const symbols = getSymbolLocations(filePath);
    res.json({ file: filePath, symbols });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
