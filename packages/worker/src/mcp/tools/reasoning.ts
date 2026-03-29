import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getReasoningData,
  logReasoning,
  getPendingRecords,
  confirmRecord,
  discardRecord,
} from "../../services/reasoning/service.js";

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

  // ── reasoning_pending ──────────────────────────────────────────────────────
  server.tool(
    "reasoning_pending",
    "List all unconfirmed (extracted or inferred) records for a repo. Returns decisions, risks, and deferred items that a human has not yet reviewed. Use this to drive the /lore review flow.",
    {
      repo: z.string().optional().describe("Repo path to filter by (defaults to all)"),
    },
    async ({ repo }) => {
      const records = await getPendingRecords(repo);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(records, null, 2) }],
      };
    },
  );

  // ── reasoning_confirm ──────────────────────────────────────────────────────
  server.tool(
    "reasoning_confirm",
    "Mark a pending record as confirmed. Only humans should call this — it sets confidence to 'confirmed' and records the reviewer's git email. Provide the record id and its table (decisions | deferred_work | risks).",
    {
      id: z.string().describe("Record ID to confirm"),
      table: z
        .enum(["decisions", "deferred_work", "risks"])
        .describe("Table the record belongs to"),
    },
    async ({ id, table }) => {
      await confirmRecord(id, table);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, id, table, confidence: "confirmed" }) }],
      };
    },
  );

  // ── reasoning_discard ──────────────────────────────────────────────────────
  server.tool(
    "reasoning_discard",
    "Permanently delete a pending record. Use when a record is incorrect, irrelevant, or a duplicate. Provide the record id and its table.",
    {
      id: z.string().describe("Record ID to discard"),
      table: z
        .enum(["decisions", "deferred_work", "risks"])
        .describe("Table the record belongs to"),
    },
    async ({ id, table }) => {
      await discardRecord(id, table);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, id, table, discarded: true }) }],
      };
    },
  );
}
