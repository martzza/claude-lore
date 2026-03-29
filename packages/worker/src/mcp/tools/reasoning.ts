import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getReasoningData, logReasoning } from "../../services/reasoning/service.js";

export function registerReasoningTools(server: McpServer): void {
  server.tool(
    "reasoning_get",
    "Get decisions, deferred work, and risks from the knowledge graph. Each record's content is prefixed with its confidence tier.",
    {
      symbol: z.string().optional().describe("Filter by symbol/function/class name"),
      repo: z.string().optional().describe("Repo path to filter by (defaults to all)"),
    },
    async ({ symbol, repo }) => {
      const result = await getReasoningData(symbol, repo);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    "reasoning_log",
    "Write a decision, deferred work item, or risk to the knowledge graph. Confidence is always 'extracted' — only humans can confirm.",
    {
      type: z
        .enum(["decision", "deferred", "risk"])
        .describe("Record type"),
      content: z.string().describe("Content of the record"),
      symbol: z.string().optional().describe("Symbol this record is anchored to"),
      repo: z.string().optional().describe("Repo path (defaults to cwd)"),
      session_id: z.string().optional().describe("Session ID to associate this record with"),
    },
    async ({ type, content, symbol, repo, session_id }) => {
      const id = await logReasoning(type, content, symbol, repo, session_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id, type, confidence: "extracted" }),
          },
        ],
      };
    },
  );
}
