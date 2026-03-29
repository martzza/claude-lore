import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readFileSync } from "fs";
import { isAbsolute } from "path";
import { getAnnotationsForFile, getAnnotationCoverage, getSymbolLocations } from "../../services/annotation/mapper.js";
import { renderAnnotatedSource } from "../../services/annotation/renderer.js";
import { buildProvenance, formatProvenanceText, formatProvenanceMermaid, formatProvenanceHtml } from "../../services/annotation/provenance.js";

export function registerAnnotationTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // annotate_file — annotated source view
  // -------------------------------------------------------------------------

  server.tool(
    "annotate_file",
    "Get reasoning annotations for a source file. Default format is 'json' for MCP (Claude Code summarises conversationally). Use 'html' to get a self-contained page for browser viewing.",
    {
      file_path: z.string().describe("Absolute path to the source file"),
      repo: z.string().optional().describe("Repo path for record lookup (defaults to cwd)"),
      format: z
        .enum(["json", "html"])
        .optional()
        .describe("Output format: 'json' (default) or 'html'"),
    },
    async ({ file_path, repo, format = "json" }) => {
      if (!isAbsolute(file_path)) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "file_path must be absolute" }) }],
        };
      }
      if (!existsSync(file_path)) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `file not found: ${file_path}` }) }],
        };
      }

      const repoPath = repo ?? process.cwd();
      const annotations = await getAnnotationsForFile(file_path, repoPath);

      if (format === "html") {
        const fileContent = readFileSync(file_path, "utf8");
        const html = renderAnnotatedSource(file_path, fileContent, annotations, repoPath);
        return { content: [{ type: "text" as const, text: html }] };
      }

      // json — return structured summary suitable for Claude to narrate
      const result = {
        file: file_path,
        repo: repoPath,
        annotations,
        summary: {
          total_annotated_lines: annotations.length,
          symbols: annotations.map((a) => a.symbol),
          decision_count: annotations.reduce(
            (n, a) => n + a.records.filter((r) => r.type === "decision").length, 0,
          ),
          risk_count: annotations.reduce(
            (n, a) => n + a.records.filter((r) => r.type === "risk").length, 0,
          ),
          deferred_count: annotations.reduce(
            (n, a) => n + a.records.filter((r) => r.type === "deferred").length, 0,
          ),
        },
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // -------------------------------------------------------------------------
  // provenance_trace — full symbol history
  // -------------------------------------------------------------------------

  server.tool(
    "provenance_trace",
    "Get the full provenance trace for a symbol — chronological story of how it came to exist: sessions, decisions, alternatives rejected, risks identified, deferred work. Default format is 'text' for MCP (readable in chat). 'mermaid' renders inline in Claude Code.",
    {
      symbol: z.string().describe("Symbol name (function, class, const)"),
      repo: z.string().optional().describe("Repo path (defaults to cwd)"),
      format: z
        .enum(["text", "html", "mermaid", "json"])
        .optional()
        .describe("Output format: text (default), html, mermaid, or json"),
    },
    async ({ symbol, repo, format = "text" }) => {
      const repoPath = repo ?? process.cwd();
      const trace = await buildProvenance(symbol, repoPath);

      let text: string;
      switch (format) {
        case "json":
          text = JSON.stringify(trace, null, 2);
          break;
        case "mermaid":
          text = formatProvenanceMermaid(trace);
          break;
        case "html":
          text = formatProvenanceHtml(trace);
          break;
        default:
          text = formatProvenanceText(trace);
          break;
      }

      return { content: [{ type: "text" as const, text }] };
    },
  );

  // -------------------------------------------------------------------------
  // annotation_coverage — coverage report
  // -------------------------------------------------------------------------

  server.tool(
    "annotation_coverage",
    "Get annotation coverage statistics for a repo — which symbols have reasoning records, which don't. Returns coverage percentage and a list of unannotated symbols.",
    {
      repo: z.string().optional().describe("Repo path (defaults to cwd)"),
      cwd: z.string().optional().describe("Working directory to scan for source files (defaults to repo)"),
    },
    async ({ repo, cwd }) => {
      const repoPath = repo ?? process.cwd();
      const scanDir = cwd ?? repoPath;

      const { readdirSync, statSync } = await import("fs");
      const { join } = await import("path");

      const srcExts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".go"]);
      const ignoreDirs = new Set(["node_modules", ".git", "dist", "build", ".codegraph"]);

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

      const filePaths = collectFiles(scanDir, 0);
      const stats = await getAnnotationCoverage(filePaths, repoPath);
      const result = { ...stats, repo: repoPath, cwd: scanDir, files_scanned: filePaths.length };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
