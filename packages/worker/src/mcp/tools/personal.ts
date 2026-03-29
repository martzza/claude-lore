import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logPersonal, getPersonal } from "../../services/reasoning/service.js";

export function registerPersonalTools(server: McpServer): void {
  server.tool(
    "personal_log",
    "Write a personal record to personal.db — never synced to any remote store.",
    {
      type: z.string().describe("Record type (note, decision, deferred, risk, etc.)"),
      content: z.string().describe("Content of the record"),
      symbol: z.string().optional().describe("Symbol this record is anchored to"),
      repo: z.string().optional().describe("Repo path (defaults to cwd)"),
    },
    async ({ type, content, symbol, repo }) => {
      const id = await logPersonal(type, content, symbol, repo);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id, type, confidence: "extracted", tier: "personal" }),
          },
        ],
      };
    },
  );

  server.tool(
    "personal_get",
    "Retrieve personal records from personal.db. Records are local-only and never synced.",
    {
      symbol: z.string().optional().describe("Filter by symbol name"),
      repo: z.string().optional().describe("Filter by repo path"),
    },
    async ({ symbol, repo }) => {
      const records = await getPersonal(symbol, repo);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ records }, null, 2) }],
      };
    },
  );
}
