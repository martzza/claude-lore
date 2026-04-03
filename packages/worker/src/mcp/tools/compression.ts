import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionsDb } from "../../services/sqlite/db.js";
import { applyMcpCompression, type McpCompressionResult } from "../../services/compression/service.js";

const EXTRACTION_PROMPT = `You are summarising an AI coding session for a knowledge graph.

Given the raw session observations below, extract a structured JSON object with these fields:
- summary: 2-3 sentence summary of what happened this session
- symbols_touched: array of symbol/function/class names that were referenced or modified
- decisions: array of architectural decisions made ({ content, rationale?, symbol? })
- deferred: array of work items explicitly parked for later ({ content, symbol? })
- risks: array of risks or constraints identified ({ content, symbol? })
- adr_candidates: array of decisions worth formal ADR review (strings)

Rules:
- All extracted records have confidence "extracted" — never write "confirmed"
- Include only clear signals, not every line
- Return ONLY valid JSON, no markdown fences, no explanation`;

export function registerCompressionTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // compress_session — fetch pending session observations for AI extraction
  // -------------------------------------------------------------------------
  server.tool(
    "compress_session",
    "Fetch the oldest pending session that needs AI compression and return its observations as an extraction prompt. Call submit_compression with the extracted JSON when done. Returns null session_id when no sessions are pending.",
    {
      repo: z.string().describe("Repo path to check for pending compression sessions"),
    },
    async ({ repo }) => {
      // Find oldest pending session for this repo
      const pending = await sessionsDb.execute({
        sql: `SELECT id, service
              FROM sessions
              WHERE repo = ?
                AND pending_compression = 1
              ORDER BY ended_at ASC
              LIMIT 1`,
        args: [repo],
      });

      if (pending.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ session_id: null, message: "No sessions pending compression for this repo." }) }],
        };
      }

      const row = pending.rows[0] as Record<string, unknown>;
      const sessionId = String(row["id"]);
      const service = row["service"] != null ? String(row["service"]) : null;

      // Fetch observations
      const obs = await sessionsDb.execute({
        sql: `SELECT tool_name, content FROM observations WHERE session_id = ? ORDER BY created_at ASC`,
        args: [sessionId],
      });

      const observationText = obs.rows
        .map((o) => {
          const r = o as Record<string, unknown>;
          return `[${String(r["tool_name"] ?? "note")}] ${String(r["content"])}`;
        })
        .join("\n");

      const prompt = `${EXTRACTION_PROMPT}\n\n## Observations\n${observationText}`;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              session_id: sessionId,
              repo,
              service,
              observation_count: obs.rows.length,
              prompt,
            }),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // submit_compression — store AI-extracted records and clear pending flag
  // -------------------------------------------------------------------------
  server.tool(
    "submit_compression",
    "Submit AI-extracted compression results for a session. Stores decisions/risks/deferred items with supersession detection and marks the session compression as complete. Pass the JSON you extracted from compress_session's prompt.",
    {
      session_id: z.string().describe("Session ID returned by compress_session"),
      repo: z.string().describe("Repo path (same as passed to compress_session)"),
      extraction: z.object({
        summary: z.string(),
        symbols_touched: z.array(z.string()).optional().default([]),
        decisions: z
          .array(z.object({ content: z.string(), rationale: z.string().optional(), symbol: z.string().optional() }))
          .optional()
          .default([]),
        deferred: z
          .array(z.object({ content: z.string(), symbol: z.string().optional() }))
          .optional()
          .default([]),
        risks: z
          .array(z.object({ content: z.string(), symbol: z.string().optional() }))
          .optional()
          .default([]),
        adr_candidates: z.array(z.string()).optional().default([]),
      }).describe("The extracted compression result"),
    },
    async ({ session_id, repo, extraction }) => {
      // Verify session belongs to this repo and is still pending
      const check = await sessionsDb.execute({
        sql: `SELECT id, service, pending_compression FROM sessions WHERE id = ? AND repo = ?`,
        args: [session_id, repo],
      });

      if (check.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "Session not found for this repo" }) }],
        };
      }

      const sessionRow = check.rows[0] as Record<string, unknown>;
      if (Number(sessionRow["pending_compression"]) !== 1) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "Session is not pending compression (already upgraded or not queued)" }) }],
        };
      }

      const service = sessionRow["service"] != null ? String(sessionRow["service"]) : undefined;

      const result: McpCompressionResult = {
        summary: extraction.summary,
        symbols_touched: extraction.symbols_touched,
        decisions: extraction.decisions,
        deferred: extraction.deferred,
        risks: extraction.risks,
        adr_candidates: extraction.adr_candidates,
      };

      await applyMcpCompression(session_id, repo, result, service);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              session_id,
              decisions_written: result.decisions.length,
              risks_written: result.risks.length,
              deferred_written: result.deferred.length,
              adr_candidates: result.adr_candidates.length,
              compression_source: "mcp",
            }),
          },
        ],
      };
    },
  );
}
