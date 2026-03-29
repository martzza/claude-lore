import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { homedir } from "os";
import { analyseKnowledgeGaps } from "../../services/advisor/gaps.js";
import { analyseClaudeMd } from "../../services/advisor/claudemd.js";
import { analyseSkillGaps } from "../../services/advisor/skills.js";
import { analyseParallelism, analyseParallelismFromDeferred } from "../../services/advisor/parallel.js";
import { analyseWorkflow } from "../../services/advisor/workflow.js";
import { getLastSessionSummary, getOpenDeferredWork } from "../../services/sessions/service.js";

export function registerAdvisorTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // advisor_summary — all five analyses in one call
  // -------------------------------------------------------------------------
  server.tool(
    "advisor_summary",
    "Run all advisor analyses (knowledge gaps, CLAUDE.md quality, skill gaps, parallelism, workflow) and return a combined summary for the repo.",
    {
      repo: z.string().describe("Repo identifier (e.g. 'my-app' or absolute path)"),
      cwd: z
        .string()
        .optional()
        .describe("Absolute path to the repo root. Required for CLAUDE.md and structural gap analysis."),
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .default(30)
        .describe("Lookback window in days for skill gap and workflow analysis (default: 30)"),
    },
    async ({ repo, cwd, days }) => {
      const effectiveCwd = cwd ?? homedir();

      const [gapsResult, claudeMdResult, skillsResult, parallelResult, workflowResult] =
        await Promise.allSettled([
          analyseKnowledgeGaps(repo, effectiveCwd),
          analyseClaudeMd(repo, effectiveCwd),
          analyseSkillGaps(repo, days),
          analyseParallelismFromDeferred(repo),
          analyseWorkflow(repo, days),
        ]);

      const gaps =
        gapsResult.status === "fulfilled"
          ? gapsResult.value
          : { error: String((gapsResult as PromiseRejectedResult).reason), priority_gaps: [], quick_wins: [], total_gap_score: 0 };

      const claudeMd =
        claudeMdResult.status === "fulfilled"
          ? claudeMdResult.value
          : { error: String((claudeMdResult as PromiseRejectedResult).reason), findings: [], token_estimate: 0 };

      const skills =
        skillsResult.status === "fulfilled"
          ? skillsResult.value
          : { error: String((skillsResult as PromiseRejectedResult).reason), suggestions: [], sessions_analysed: 0 };

      const parallel =
        parallelResult.status === "fulfilled"
          ? parallelResult.value
          : { error: String((parallelResult as PromiseRejectedResult).reason), parallel_groups: [], serial_required: [], analysed_items: 0, estimated_speedup: 1 };

      const workflow =
        workflowResult.status === "fulfilled"
          ? workflowResult.value
          : { error: String((workflowResult as PromiseRejectedResult).reason), patterns: [], recommendations: [], sessions_analysed: 0 };

      const summary = {
        repo,
        generated_at: Date.now(),
        gaps: {
          total_gap_score: gaps.total_gap_score,
          priority_count: gaps.priority_gaps.length,
          quick_win_count: gaps.quick_wins.length,
          top_priority: gaps.priority_gaps[0] ?? null,
        },
        claude_md: {
          present: "claude_md_present" in claudeMd ? (claudeMd as { claude_md_present: boolean }).claude_md_present : false,
          token_estimate: claudeMd.token_estimate ?? 0,
          finding_count: claudeMd.findings.length,
          top_finding: claudeMd.findings[0] ?? null,
        },
        skills: {
          sessions_analysed: skills.sessions_analysed ?? 0,
          suggestion_count: skills.suggestions.length,
          top_suggestion: skills.suggestions[0] ?? null,
        },
        parallel: {
          analysed_items: parallel.analysed_items,
          parallel_group_count: parallel.parallel_groups.length,
          serial_count: parallel.serial_required.length,
          estimated_speedup: parallel.estimated_speedup,
        },
        workflow: {
          sessions_analysed: workflow.sessions_analysed ?? 0,
          pattern_count: workflow.patterns.length,
          recommendation_count: workflow.recommendations.length,
          top_recommendation: workflow.recommendations[0] ?? null,
        },
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // parallelism_check
  // -------------------------------------------------------------------------
  server.tool(
    "parallelism_check",
    "Given a list of task descriptions, determines which tasks are safe to run as parallel Claude Code subagents and generates ready-to-use subagent prompts.",
    {
      repo: z.string().describe("Repo identifier"),
      tasks: z
        .array(z.string())
        .min(1)
        .max(50)
        .optional()
        .describe("Task descriptions to analyse. If omitted, reads open deferred items from the DB."),
    },
    async ({ repo, tasks }) => {
      const analysis = tasks && tasks.length > 0
        ? await analyseParallelism(repo, tasks)
        : await analyseParallelismFromDeferred(repo);

      return {
        content: [{ type: "text" as const, text: JSON.stringify(analysis, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // workflow_summary
  // -------------------------------------------------------------------------
  server.tool(
    "workflow_summary",
    "Returns top workflow recommendations based on session history patterns (context switching, decision timing, deferred item management).",
    {
      repo: z.string().describe("Repo identifier"),
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .default(60)
        .describe("Lookback window in days (default: 60)"),
    },
    async ({ repo, days }) => {
      const analysis = await analyseWorkflow(repo, days);
      // Return top 3 recommendations with patterns for context
      const result = {
        sessions_analysed: analysis.sessions_analysed,
        patterns: analysis.patterns,
        top_recommendations: analysis.recommendations.slice(0, 3),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // session_handover
  // -------------------------------------------------------------------------
  server.tool(
    "session_handover",
    "Returns a structured handover document: what was completed, what is in flight, pending reviews, and exactly what to do next. Feeds the session-handover agent.",
    {
      repo: z.string().describe("Repo identifier"),
    },
    async ({ repo }) => {
      const [lastSession, openDeferred] = await Promise.all([
        getLastSessionSummary(repo),
        getOpenDeferredWork(repo),
      ]);

      const date = new Date().toISOString().slice(0, 10);
      const lines: string[] = [
        `# Session handover — ${repo} — ${date}`,
        "",
        "## What was completed",
        lastSession?.summary ?? "No session summary available.",
        "",
        "## What is in flight",
      ];

      if (openDeferred.length === 0) {
        lines.push("No open deferred items.");
      } else {
        for (const item of openDeferred) {
          const d = item as Record<string, unknown>;
          const sym = d["symbol"] ? ` *(${String(d["symbol"])})*` : "";
          lines.push(`- ${String(d["content"])}${sym}`);
        }
      }

      lines.push("", "## Exactly what to do next");
      if (openDeferred.length === 0) {
        lines.push("1. Check session summary above for direction.");
      } else {
        const topThree = (openDeferred as Record<string, unknown>[]).slice(0, 3);
        topThree.forEach((item, i) => {
          lines.push(`${i + 1}. ${String(item["content"]).slice(0, 120)}`);
        });
      }

      lines.push(
        "",
        "## Pending reviews",
        `Run \`claude-lore review\` to confirm extracted records.`,
        `Run \`claude-lore advisor gaps\` to check knowledge gaps.`,
        "",
        "## Notes",
        "Use the session-handover agent for a richer handover with pending record counts and gap scores.",
      );

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );
}
