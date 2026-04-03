import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionsDb } from "../../services/sqlite/db.js";
import { getLastSessionSummary } from "../../services/sessions/service.js";

export function registerSessionTools(server: McpServer): void {
  server.tool(
    "session_load",
    "Load the last session summary and open deferred work for a repo. Deferred items are split into current (recent or blocked) and possibly_completed (older than 30 days without a blocker, with zombie signal if the anchor symbol was touched recently).",
    {
      repo: z.string().describe("Repo path"),
      service: z.string().optional().describe("Service/package name to scope results within a monorepo"),
    },
    async ({ repo, service }) => {
      const svcClause = service !== undefined ? " AND service IS ?" : "";
      const svcArgs = (base: (string | null)[]): (string | null)[] =>
        service !== undefined ? [...base, service] : base;

      const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;

      const [lastSession, deferredRes] = await Promise.all([
        getLastSessionSummary(repo, service),
        sessionsDb.execute({
          sql: `SELECT id, content, symbol, blocked_by, created_at, touched_by_sessions
                FROM deferred_work
                WHERE repo = ? AND lifecycle_status = 'active' AND deprecated_by IS NULL AND status = 'open'${svcClause}
                ORDER BY blocked_by IS NOT NULL DESC, created_at DESC
                LIMIT 50`,
          args: svcArgs([repo]),
        }),
      ]);

      const current: Record<string, unknown>[] = [];
      const possiblyCompleted: Record<string, unknown>[] = [];

      for (const row of deferredRes.rows) {
        const r = row as Record<string, unknown>;
        const createdAt = Number(r["created_at"] ?? 0);
        const blockedBy = r["blocked_by"] != null ? String(r["blocked_by"]) : null;
        const isOld = createdAt < cutoffMs;

        let touched: string[] = [];
        try { touched = JSON.parse(String(r["touched_by_sessions"] ?? "[]")); } catch {}

        const entry: Record<string, unknown> = {
          id: r["id"],
          content: r["content"],
          symbol: r["symbol"] ?? null,
          blocked_by: blockedBy,
          created_at: createdAt,
        };
        if (touched.length >= 2) {
          entry["zombie_signal"] = `touched in ${touched.length} sessions`;
        }

        if (!isOld || blockedBy) {
          current.push(entry);
        } else {
          possiblyCompleted.push(entry);
        }
      }

      const result = {
        last_session: lastSession,
        open_deferred: { current, possibly_completed: possiblyCompleted },
      };
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
