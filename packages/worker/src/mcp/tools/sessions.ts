import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionsDb } from "../../services/sqlite/db.js";
import { getLastSessionSummary, getOpenDeferredWork } from "../../services/sessions/service.js";

export function registerSessionTools(server: McpServer): void {
  server.tool(
    "session_load",
    "Load the last session summary and open deferred work items for a repo.",
    {
      repo: z.string().describe("Repo path"),
      service: z.string().optional().describe("Service/package name to scope results within a monorepo (e.g. 'api', '@acme/worker')"),
    },
    async ({ repo, service }) => {
      const [lastSession, openDeferred] = await Promise.all([
        getLastSessionSummary(repo, service),
        getOpenDeferredWork(repo, service),
      ]);
      const result = { last_session: lastSession, open_deferred: openDeferred };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    "session_search",
    "Full-text search across session summaries and observations.",
    {
      query: z.string().describe("Search query"),
      repo: z.string().optional().describe("Limit to a specific repo"),
      service: z.string().optional().describe("Service/package name to scope results within a monorepo"),
    },
    async ({ query, repo, service }) => {
      const pattern = `%${query}%`;
      const sessionArgs: (string | null)[] = [pattern, pattern];
      const sessionClauses: string[] = [];
      if (repo) { sessionClauses.push("s.repo = ?"); sessionArgs.push(repo); }
      if (service !== undefined) { sessionClauses.push("s.service IS ?"); sessionArgs.push(service ?? null); }
      const sessionWhere = sessionClauses.length > 0 ? `AND ${sessionClauses.join(" AND ")}` : "";

      const sessionRes = await sessionsDb.execute({
        sql: `SELECT s.id, s.repo, s.service, s.summary, s.status, s.started_at, s.ended_at
              FROM sessions s
              WHERE (s.summary LIKE ? OR s.id LIKE ?) ${sessionWhere}
              ORDER BY s.started_at DESC
              LIMIT 20`,
        args: sessionArgs,
      });

      const obsArgs: (string | null)[] = [pattern];
      const obsClauses: string[] = [];
      if (repo) { obsClauses.push("o.repo = ?"); obsArgs.push(repo); }
      if (service !== undefined) { obsClauses.push("o.service IS ?"); obsArgs.push(service ?? null); }
      const obsWhere = obsClauses.length > 0 ? `AND ${obsClauses.join(" AND ")}` : "";

      const observationRes = await sessionsDb.execute({
        sql: `SELECT DISTINCT o.session_id, o.tool_name,
                     substr(o.content, 1, 200) AS snippet, o.created_at
              FROM observations o
              WHERE o.content LIKE ? ${obsWhere}
              ORDER BY o.created_at DESC
              LIMIT 20`,
        args: obsArgs,
      });

      const result = {
        sessions: sessionRes.rows,
        observation_snippets: observationRes.rows,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
