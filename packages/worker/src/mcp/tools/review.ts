import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { buildDepGraph, enrichDepGraph } from "../../services/review/deps.js";
import { getCachedGraph, setCachedGraph } from "../../services/review/cache.js";
import { renderCodebaseMap } from "../../services/review/renderers/map.js";
import { renderPropagationView } from "../../services/review/renderers/propagation.js";
import { buildReview, renderReviewHtml } from "../../services/review/renderers/review.js";

export function registerReviewTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // review_map — codebase file dependency map
  // -------------------------------------------------------------------------

  server.tool(
    "review_map",
    "Generate a visual codebase map showing file dependencies coloured by reasoning coverage. Click any node to open a panel with three tabs: Annotations (full decision/risk/deferred records), Code (source with highlighted lines), and Deps (imports). Returns an HTML file path to open in browser, or JSON summary.",
    {
      repo: z.string().describe("Repo path"),
      cwd: z.string().optional().describe("Directory to scan (defaults to repo)"),
      format: z.enum(["html", "json"]).optional().describe("Output format (default: html)"),
      layout: z.enum(["force", "radial"]).optional().describe("Graph layout (default: force)"),
      open: z.boolean().optional().describe("Open result in browser"),
    },
    async ({ repo, cwd: cwdOpt, format = "html", layout = "force", open = true }) => {
      const cwd = cwdOpt ?? repo;

      try {
        let graph = getCachedGraph(cwd);
        if (!graph) {
          graph = await buildDepGraph(repo, cwd);
          setCachedGraph(cwd, graph);
        }

        if (format === "json") {
          const summary = {
            nodes: graph.nodes.length,
            edges: graph.edges.length,
            entry_points: graph.entry_points,
            top_files_by_dependents: graph.nodes
              .sort((a, b) => b.dependents.length - a.dependents.length)
              .slice(0, 10)
              .map((n) => ({ path: n.path, imported_by: n.dependents.length })),
          };
          return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
        }

        const enriched = await enrichDepGraph(graph, repo);
        const html = renderCodebaseMap(enriched, repo, layout);
        const outPath = join(tmpdir(), "claude-lore-map.html");
        writeFileSync(outPath, html, "utf8");

        if (open) {
          try { execSync(`open "${outPath}"`, { stdio: "ignore" }); } catch { /* ok */ }
        }

        return {
          content: [{
            type: "text" as const,
            text: `Codebase map written to: ${outPath}\n\n` +
              `${graph.nodes.length} files · ${graph.edges.length} edges · ${graph.entry_points.length} entry point(s)\n\n` +
              `Node colours: red=risk · blue=decision · amber=deferred · grey=no reasoning\n\n` +
              `Click any node to open the detail panel:\n` +
              `  Annotations — full decision/risk/deferred record content\n` +
              `  Code        — source with symbol-highlighted lines\n` +
              `  Deps        — imports and imported-by lists`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(err) }) }] };
      }
    },
  );

  // -------------------------------------------------------------------------
  // review_propagation — decision propagation view for a specific file
  // -------------------------------------------------------------------------

  server.tool(
    "review_propagation",
    "Show which files are transitively affected when a given file changes. Highlights all upstream files that import it (directly or indirectly) and surfaces any reasoning records on those files.",
    {
      repo: z.string().describe("Repo path"),
      cwd: z.string().optional().describe("Directory to scan (defaults to repo)"),
      file: z.string().describe("Relative file path (from cwd) to use as the focus node"),
      format: z.enum(["html", "json"]).optional().describe("Output format (default: html)"),
      open: z.boolean().optional().describe("Open result in browser"),
    },
    async ({ repo, cwd: cwdOpt, file, format = "html", open = true }) => {
      const cwd = cwdOpt ?? repo;

      try {
        let graph = getCachedGraph(cwd);
        if (!graph) {
          graph = await buildDepGraph(repo, cwd);
          setCachedGraph(cwd, graph);
        }

        if (format === "json") {
          const affected = new Set<string>([file]);
          const queue = [file];
          while (queue.length > 0) {
            const cur = queue.shift()!;
            const node = graph.nodes.find((n) => n.path === cur);
            if (!node) continue;
            for (const dep of node.dependents) {
              if (!affected.has(dep)) { affected.add(dep); queue.push(dep); }
            }
          }
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ focus: file, affected: Array.from(affected), count: affected.size }, null, 2),
            }],
          };
        }

        const enriched = await enrichDepGraph(graph, repo);
        const html = renderPropagationView(enriched, file, repo);
        const outPath = join(tmpdir(), "claude-lore-propagation.html");
        writeFileSync(outPath, html, "utf8");

        if (open) {
          try { execSync(`open "${outPath}"`, { stdio: "ignore" }); } catch { /* ok */ }
        }

        // Count affected
        const affected = new Set<string>([file]);
        const queue2 = [file];
        while (queue2.length > 0) {
          const cur = queue2.shift()!;
          const node = graph.nodes.find((n) => n.path === cur);
          if (!node) continue;
          for (const dep of node.dependents) {
            if (!affected.has(dep)) { affected.add(dep); queue2.push(dep); }
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: `Propagation view written to: ${outPath}\n\n` +
              `Changing ${file} affects ${affected.size} file(s) transitively.\n\n` +
              `The graph shows all upstream files — yellow border = focus, red fill = has risks.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(err) }) }] };
      }
    },
  );

  // -------------------------------------------------------------------------
  // review_diff — pre-commit review with reasoning overlay
  // -------------------------------------------------------------------------

  server.tool(
    "review_diff",
    "Generate a pre-commit review that overlays reasoning records (decisions, risks, deferred items) onto the git diff. Returns an HTML page or JSON summary of changed files with their associated reasoning.",
    {
      repo: z.string().describe("Repo path"),
      cwd: z.string().optional().describe("Working directory (defaults to repo)"),
      base: z.string().optional().describe("Git base ref (default: HEAD — shows unstaged+staged changes)"),
      format: z.enum(["html", "json"]).optional().describe("Output format (default: html)"),
      open: z.boolean().optional().describe("Open result in browser"),
    },
    async ({ repo, cwd: cwdOpt, base = "HEAD", format = "html", open = true }) => {
      const cwd = cwdOpt ?? repo;

      try {
        if (format === "json") {
          const { getGitDiff } = await import("../../services/review/renderers/review.js");
          const diffs = getGitDiff(cwd, base);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                base,
                files: diffs.map((d) => ({
                  path: d.path,
                  status: d.status,
                  lines_added: d.lines_added,
                  lines_removed: d.lines_removed,
                })),
              }, null, 2),
            }],
          };
        }

        const reviews = await buildReview(cwd, repo, base);

        if (reviews.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No changes found relative to ${base}.` }],
          };
        }

        const html = renderReviewHtml(reviews, cwd, base);
        const outPath = join(tmpdir(), "claude-lore-review.html");
        writeFileSync(outPath, html, "utf8");

        if (open) {
          try { execSync(`open "${outPath}"`, { stdio: "ignore" }); } catch { /* ok */ }
        }

        const totalWarnings = reviews.reduce((a, r) => a + r.warnings.length, 0);
        const totalRecords = reviews.reduce((a, r) => a + r.records.length, 0);
        const warnings = reviews
          .flatMap((r) => r.warnings.map((w) => `${r.file.path}: ${w}`))
          .slice(0, 5);

        let text = `Pre-commit review written to: ${outPath}\n\n` +
          `${reviews.length} file(s) changed · ${totalRecords} reasoning record(s) · ${totalWarnings} warning(s)\n`;

        if (warnings.length > 0) {
          text += `\nWarnings:\n${warnings.map((w) => `  ⚠ ${w}`).join("\n")}`;
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(err) }) }] };
      }
    },
  );
}
