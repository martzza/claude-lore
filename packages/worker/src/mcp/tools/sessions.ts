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
    },
    async ({ repo }) => {
      const [lastSession, openDeferred] = await Promise.all([
        getLastSessionSummary(repo),
        getOpenDeferredWork(repo),
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
    },
    async ({ query, repo }) => {
      const pattern = `%${query}%`;
      const repoClause = repo ? "AND s.repo = ?" : "";
      const args: unknown[] = [pattern, pattern];
      if (repo) args.push(repo);

      const sessionRes = await sessionsDb.execute({
        sql: `SELECT s.id, s.repo, s.summary, s.status, s.started_at, s.ended_at
              FROM sessions s
              WHERE (s.summary LIKE ? OR s.id LIKE ?) ${repoClause}
              ORDER BY s.started_at DESC
              LIMIT 20`,
        args,
      });

      const observationArgs: unknown[] = [pattern];
      if (repo) observationArgs.push(repo);
      const observationRes = await sessionsDb.execute({
        sql: `SELECT DISTINCT o.session_id, o.tool_name,
                     substr(o.content, 1, 200) AS snippet, o.created_at
              FROM observations o
              WHERE o.content LIKE ? ${repo ? "AND o.repo = ?" : ""}
              ORDER BY o.created_at DESC
              LIMIT 20`,
        args: observationArgs,
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
