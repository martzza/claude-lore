import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getReasoningDataGrouped,
  logReasoning,
  findMcpSupersessionCandidates,
  getPendingRecords,
  confirmRecord,
  discardRecord,
} from "../../services/reasoning/service.js";

export function registerReasoningTools(server: McpServer): void {
  server.tool(
    "reasoning_get",
    "Get decisions, deferred work, and risks from the knowledge graph, grouped by lifecycle status. Returns active records, historical (stale) decisions, recently superseded decisions, and conflict pairs where confidence='contested'. Each record's content is prefixed with its confidence tier.",
    {
      symbol: z.string().optional().describe("Filter by symbol/function/class name"),
      repo: z.string().optional().describe("Repo path to filter by (defaults to all)"),
      service: z.string().optional().describe("Service/package name to scope results within a monorepo (e.g. 'api', '@acme/worker', 'packages/auth')"),
    },
    async ({ symbol, repo, service }) => {
      const result = await getReasoningDataGrouped(symbol, repo, service);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    "reasoning_log",
    "Write a decision, deferred work item, or risk to the knowledge graph. Confidence is always 'extracted' — only humans can confirm. For decisions: if existing decisions exist on the same symbol and no supersedes is provided, returns candidates_found so you can link the supersession chain.",
    {
      type: z
        .enum(["decision", "deferred", "risk"])
        .describe("Record type"),
      content: z.string().describe("Content of the record"),
      symbol: z.string().optional().describe("Symbol this record is anchored to"),
      repo: z.string().optional().describe("Repo path (defaults to cwd)"),
      session_id: z.string().optional().describe("Session ID to associate this record with"),
      service: z.string().optional().describe("Service/package name within a monorepo (e.g. 'api', '@acme/worker', 'packages/auth')"),
      supersedes: z.string().optional().describe("ID of an existing decision this one replaces. When provided, the old decision is marked superseded and this one is linked to it."),
      amendment_of: z.string().optional().describe("ID of an existing decision this one partially amends (vs. fully replacing it)."),
    },
    async ({ type, content, symbol, repo, session_id, service, supersedes, amendment_of }) => {
      // For decisions without an explicit supersedes link: check for existing decisions
      // on the same symbol and surface them so the agent can decide whether to link
      if (type === "decision" && !supersedes && symbol) {
        const repoVal = repo ?? process.cwd();
        const candidates = await findMcpSupersessionCandidates(repoVal, symbol);
        if (candidates.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "candidates_found",
                  message:
                    `Found ${candidates.length} existing decision(s) on symbol "${symbol}". ` +
                    `If this decision replaces one of them, call reasoning_log again with supersedes: "<id>". ` +
                    `To write without linking, call again with the same args plus supersedes: null.`,
                  candidates,
                }),
              },
            ],
          };
        }
      }

      const id = await logReasoning(type, content, symbol, repo, session_id, service, supersedes, amendment_of);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ id, type, confidence: "extracted", supersedes: supersedes ?? null }),
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
      service: z.string().optional().describe("Service/package name to scope results within a monorepo"),
    },
    async ({ repo, service }) => {
      const records = await getPendingRecords(repo, service);
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

  // ── reasoning_review ──────────────────────────────────────────────────────
  server.tool(
    "reasoning_review",
    "Apply a lifecycle transition to a record — mitigated, accepted, completed, abandoned, superseded, still_valid, or reopen. Only humans should call lifecycle actions. For risks: mitigated | accepted. For deferred: completed | abandoned. For all types: still_valid (refreshes review timestamp), reopen, superseded (requires superseded_by).",
    {
      id: z.string().describe("Record ID"),
      table: z
        .enum(["decisions", "deferred_work", "risks"])
        .describe("Table the record belongs to"),
      action: z
        .enum(["mitigated", "accepted", "completed", "abandoned", "superseded", "still_valid", "reopen"])
        .describe("Lifecycle action to apply"),
      note: z.string().optional().describe("Optional note for the transition (e.g. mitigation details, resolution summary)"),
      superseded_by: z.string().optional().describe("ID of the record that supersedes this one (required when action=superseded)"),
    },
    async ({ id, table, action, note, superseded_by }) => {
      const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";
      const res = await fetch(`http://127.0.0.1:${PORT}/api/records/lifecycle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, table, action, note, superseded_by }),
      });
      const body = await res.json() as Record<string, unknown>;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(body) }],
      };
    },
  );
}
