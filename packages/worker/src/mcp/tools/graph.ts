import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildDecisionHierarchy,
  buildSymbolImpactGraph,
  buildPortfolioGraph,
} from "../../services/graph/service.js";
import { toMermaid } from "../../services/graph/renderers/mermaid.js";
import { toDot } from "../../services/graph/renderers/dot.js";

function render(graph: import("../../services/graph/service.js").GraphData, format: string): string {
  if (format === "dot") return toDot(graph);
  if (format === "json") return JSON.stringify(graph, null, 2);
  return toMermaid(graph); // default: mermaid
}

export function registerGraphTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // graph_decisions(repo, format?, lifecycle?) — decision hierarchy
  // -------------------------------------------------------------------------
  server.tool(
    "graph_decisions",
    "Generate a visual decision hierarchy graph for a repo. Returns Mermaid by default — Claude Code renders Mermaid inline in chat. Use format='json' for raw data. lifecycle='active' (default) shows only active records; 'include_historical' adds stale-but-valid decisions; 'full_history' shows superseded chains.",
    {
      repo: z.string().describe("Repo path to graph"),
      format: z
        .enum(["mermaid", "dot", "json"])
        .optional()
        .default("mermaid")
        .describe("Output format. mermaid (default), dot, or json"),
      lifecycle: z
        .enum(["active", "include_historical", "full_history"])
        .optional()
        .default("active")
        .describe("Lifecycle filter: active (default), include_historical, or full_history (shows superseded chains)"),
    },
    async ({ repo, format, lifecycle }) => {
      const graph = await buildDecisionHierarchy(repo, lifecycle ?? "active");
      const text = render(graph, format ?? "mermaid");
      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // graph_symbol(symbol, repo, format?, lifecycle?) — symbol impact graph
  // -------------------------------------------------------------------------
  server.tool(
    "graph_symbol",
    "Generate a symbol impact graph — the symbol at centre, radiating out to linked decisions, risks, deferred items, and cross-repo consumers. lifecycle='active' (default), 'include_historical', or 'full_history'.",
    {
      symbol: z.string().describe("Symbol name to visualise"),
      repo: z.string().describe("Repo that owns the symbol"),
      format: z
        .enum(["mermaid", "dot", "json"])
        .optional()
        .default("mermaid")
        .describe("Output format"),
      lifecycle: z
        .enum(["active", "include_historical", "full_history"])
        .optional()
        .default("active")
        .describe("Lifecycle filter"),
    },
    async ({ symbol, repo, format, lifecycle }) => {
      const graph = await buildSymbolImpactGraph(symbol, repo, lifecycle ?? "active");
      const text = render(graph, format ?? "mermaid");
      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // graph_portfolio(repos?, format?) — cross-repo dependency map
  // -------------------------------------------------------------------------
  server.tool(
    "graph_portfolio",
    "Generate a cross-repo dependency map. Shows all repos in the registry and the symbols that connect them.",
    {
      repos: z
        .array(z.string())
        .optional()
        .describe("Optional list of repo paths to include. Defaults to all repos in registry."),
      format: z
        .enum(["mermaid", "dot", "json"])
        .optional()
        .default("mermaid")
        .describe("Output format"),
    },
    async ({ repos, format }) => {
      const graph = await buildPortfolioGraph(repos);
      const text = render(graph, format ?? "mermaid");
      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );
}
