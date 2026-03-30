import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildDecisionHierarchy,
  buildSymbolImpactGraph,
  buildPortfolioGraph,
  buildServiceGraph,
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
  // graph_decisions(repo, format?) — decision hierarchy
  // -------------------------------------------------------------------------
  server.tool(
    "graph_decisions",
    "Generate a visual decision hierarchy graph for a repo. Returns Mermaid by default — Claude Code renders Mermaid inline in chat. Use format='json' for raw data.",
    {
      repo: z.string().describe("Repo path to graph"),
      service: z.string().optional().describe("Service/package name to scope the graph within a monorepo (e.g. 'api', '@acme/worker')"),
      format: z
        .enum(["mermaid", "dot", "json"])
        .optional()
        .default("mermaid")
        .describe("Output format. mermaid (default), dot, or json"),
    },
    async ({ repo, service, format }) => {
      const graph = await buildDecisionHierarchy(repo, service);
      const text = render(graph, format ?? "mermaid");
      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // graph_services — intra-repo service dependency graph
  // -------------------------------------------------------------------------
  server.tool(
    "graph_services",
    "Generate an intra-repo service dependency graph for a monorepo. Nodes are services/packages within the repo. Edges connect services that share symbol anchors or whose reasoning records mention each other. Use this to understand cross-service coupling before making changes.",
    {
      repo: z.string().describe("Repo path to graph"),
      format: z
        .enum(["mermaid", "dot", "json"])
        .optional()
        .default("mermaid")
        .describe("Output format. mermaid (default), dot, or json"),
    },
    async ({ repo, format }) => {
      const graph = await buildServiceGraph(repo);
      if (graph.nodes.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "No service-tagged records found. Run sessions with service detection enabled, or use `claude-lore bootstrap --framework monorepo-services` to document services.",
          }],
        };
      }
      const text = render(graph, format ?? "mermaid");
      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // graph_symbol(symbol, repo, format?) — symbol impact graph
  // -------------------------------------------------------------------------
  server.tool(
    "graph_symbol",
    "Generate a symbol impact graph — the symbol at centre, radiating out to linked decisions, risks, deferred items, and cross-repo consumers.",
    {
      symbol: z.string().describe("Symbol name to visualise"),
      repo: z.string().describe("Repo that owns the symbol"),
      format: z
        .enum(["mermaid", "dot", "json"])
        .optional()
        .default("mermaid")
        .describe("Output format"),
    },
    async ({ symbol, repo, format }) => {
      const graph = await buildSymbolImpactGraph(symbol, repo);
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
