import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import { createClient } from "@libsql/client";
import { getStructuralClient } from "../../services/structural/db-cache.js";
import { getReasoningData } from "../../services/reasoning/service.js";
import { scoreChangedSymbols, getChangedSymbols, deriveVerdict } from "../../services/structural/risk-scorer.js";
import { generateWiki, renderWikiPageMarkdown, renderWikiIndexMarkdown } from "../../services/structural/wiki.js";
import { renderWikiHtml } from "../../services/structural/wiki-html.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDb(cwd: string) {
  const dbPath = join(cwd, ".codegraph", "structural.db");
  return getStructuralClient(dbPath);
}

function notIndexedError() {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: "structural index not built",
        hint: "Run: claude-lore index",
      }),
    }],
  };
}

// Extract camelCase/PascalCase/quoted tokens from a task string as symbol candidates
function extractSymbolCandidates(task: string): string[] {
  const quoted   = [...task.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2] ?? "").filter(Boolean);
  const pascal   = task.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) ?? [];
  const camel    = task.match(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g) ?? [];
  return [...new Set([...quoted, ...pascal, ...camel])].slice(0, 6);
}

// ---------------------------------------------------------------------------
// Register all structural tools
// ---------------------------------------------------------------------------

export function registerStructuralTools(server: McpServer): void {

  // ─── get_minimal_context (PRIMARY ENTRY POINT — registered first) ─────────

  server.tool(
    "get_minimal_context",
    `Primary entry point for code understanding tasks. Call this FIRST before any other structural or reasoning tools. Returns a compact context summary (~150-250 tokens) covering the most relevant symbols for the task, their blast radius, attached reasoning records, and test coverage status. Costs ~150 tokens. Replaces 3-5 separate tool calls.`,
    {
      task:    z.string().describe("Natural language description of what you are working on"),
      repo:    z.string().optional().describe("Absolute path to the repo root (defaults to cwd)"),
      service: z.string().optional().describe("Scope to a specific service/package"),
    },
    async ({ task, repo }) => {
      const cwd = repo ?? process.cwd();
      const db  = getDb(cwd);

      if (!db) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              task,
              message: "Structural index not built. Run: claude-lore index",
              next_tool_suggestions: ["claude-lore index"],
            }),
          }],
        };
      }

      const candidates = extractSymbolCandidates(task);

      // Find matching symbols (top 3 by export status + name length)
      const foundMap = new Map<string, { name: string; file: string; start_line: number; kind: string; exported: number }>();
      for (const candidate of candidates) {
        const res = await db.execute({
          sql:  `SELECT name, file, start_line, kind, exported FROM symbols
                 WHERE name LIKE '%' || ? || '%' AND is_test = 0
                 ORDER BY exported DESC, LENGTH(name) ASC LIMIT 2`,
          args: [candidate],
        });
        for (const r of res.rows) {
          const name = String(r["name"]);
          if (!foundMap.has(name)) {
            foundMap.set(name, {
              name,
              file:       String(r["file"]),
              start_line: Number(r["start_line"]),
              kind:       String(r["kind"]),
              exported:   Number(r["exported"]),
            });
          }
        }
      }

      const topSymbols = [...foundMap.values()]
        .sort((a, b) => b.exported - a.exported || a.name.length - b.name.length)
        .slice(0, 3);

      if (topSymbols.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              task,
              message: "No symbols matched. Try codegraph_search with a specific name.",
              next_tool_suggestions: ["codegraph_search"],
            }),
          }],
        };
      }

      const contextParts: string[] = [];
      const nextTools: string[] = [];

      for (const sym of topSymbols) {
        const [callersRes, calleesRes, coverageRes, communityRes] = await Promise.all([
          db.execute({
            sql:  `SELECT DISTINCT caller FROM call_graph WHERE callee = ? AND kind = 'calls' LIMIT 8`,
            args: [sym.name],
          }),
          db.execute({
            sql:  `SELECT DISTINCT callee FROM call_graph WHERE caller = ? AND kind = 'calls' LIMIT 5`,
            args: [sym.name],
          }),
          db.execute({
            sql:  `SELECT COUNT(*) as c FROM call_graph WHERE callee = ? AND kind = 'test_covers'`,
            args: [sym.name],
          }),
          db.execute({
            sql:  `SELECT community FROM symbols WHERE name = ? LIMIT 1`,
            args: [sym.name],
          }),
        ]);

        let decisions: Array<{ confidence: string; content: string }> = [];
        let risks: Array<{ confidence: string; content: string }> = [];
        try {
          const reasoning = await getReasoningData(sym.name, cwd);
          decisions = (reasoning.decisions as Array<{ confidence: string; content: string }>).slice(0, 2);
          risks     = (reasoning.risks     as Array<{ confidence: string; content: string }>).slice(0, 2);
        } catch { /* reasoning db may not exist */ }

        const callerNames  = callersRes.rows.map((r) => String(r["caller"]));
        const calleeNames  = calleesRes.rows.map((r) => String(r["callee"]));
        const testCount    = Number(coverageRes.rows[0]?.["c"] ?? 0);
        const community    = communityRes.rows[0]?.["community"]
          ? String(communityRes.rows[0]["community"]) : null;

        const parts: string[] = [`## ${sym.name} (${sym.kind}) — ${sym.file}:${sym.start_line}`];

        if (decisions.length > 0) {
          parts.push(`DECISIONS: ${decisions.map((d) =>
            `[${d.confidence}] ${String(d.content).slice(0, 70)}`).join("; ")}`);
        }
        if (risks.length > 0) {
          parts.push(`RISKS: ${risks.map((r) =>
            `[${r.confidence.toUpperCase()}] ${String(r.content).slice(0, 60)}`).join("; ")}`);
        }
        if (callerNames.length > 0) {
          parts.push(`CALLERS (${callerNames.length}): ${callerNames.join(", ")}`);
        }
        if (calleeNames.length > 0) {
          parts.push(`CALLS: ${calleeNames.join(", ")}`);
        }
        parts.push(`TESTS: ${testCount > 0 ? `${testCount} test(s) cover this` : "NONE ⚠"}`);
        if (community) {
          parts.push(`COMMUNITY: ${community}`);
          nextTools.push(`codegraph_communities(${sym.name}) — see other symbols in ${community} community`);
        }

        contextParts.push(parts.join("\n"));

        if (callerNames.length >= 8) {
          nextTools.push(`codegraph_impact(${sym.name}) — ${callerNames.length}+ callers, check full blast radius`);
        }
        if (risks.some((r) => /critical|high/i.test(r.confidence))) {
          nextTools.push(`reasoning_get(${sym.name}) — has HIGH/CRITICAL risks, review details`);
        }
        if (testCount === 0) {
          nextTools.push(`codegraph_coverage(${sym.name}) — no test coverage`);
        }
      }

      const fullText = contextParts.join("\n\n");
      const tokenEstimate = Math.ceil(fullText.split(/\s+/).length * 1.3);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            task,
            context:              fullText,
            token_estimate:       tokenEstimate,
            next_tool_suggestions: [...new Set(nextTools)].slice(0, 3),
          }),
        }],
      };
    },
  );

  // ─── codegraph_communities ────────────────────────────────────────────────

  server.tool(
    "codegraph_communities",
    "List code communities — clusters of highly interconnected symbols that form natural modules. Use this to understand high-level architecture and identify tightly coupled groups. Call with a symbol name to find which community it belongs to.",
    {
      repo:   z.string().optional().describe("Absolute path to the repo root (defaults to cwd)"),
      symbol: z.string().optional().describe("Find which community a specific symbol belongs to"),
    },
    async ({ repo, symbol }) => {
      const cwd = repo ?? process.cwd();
      const db  = getDb(cwd);
      if (!db) return notIndexedError();

      if (symbol) {
        const symRes = await db.execute({
          sql:  "SELECT community FROM symbols WHERE name = ?",
          args: [symbol],
        });

        if (!symRes.rows.length || !symRes.rows[0]!["community"]) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                symbol,
                community: null,
                message:   "Symbol not found in any community (may be isolated or index needs rebuild)",
              }),
            }],
          };
        }

        const communityName = String(symRes.rows[0]!["community"]);
        const cRes = await db.execute({
          sql:  "SELECT * FROM communities WHERE name = ?",
          args: [communityName],
        });

        if (!cRes.rows.length) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ symbol, community: communityName }),
            }],
          };
        }

        const c = cRes.rows[0]!;
        const allSymbols = JSON.parse(String(c["symbols"])) as string[];
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              symbol,
              community:      communityName,
              description:    c["description"],
              size:           c["size"],
              hub_symbol:     c["hub_symbol"],
              other_symbols:  allSymbols.filter((s) => s !== symbol).slice(0, 10),
              total_in_community: allSymbols.length,
            }),
          }],
        };
      }

      // Return all communities summary
      const allRes = await db.execute(
        "SELECT id, name, size, hub_symbol, description FROM communities ORDER BY size DESC",
      );

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            total_communities: allRes.rows.length,
            communities: allRes.rows.map((c) => ({
              name:        String(c["name"]),
              size:        Number(c["size"]),
              hub_symbol:  c["hub_symbol"] ? String(c["hub_symbol"]) : null,
              description: c["description"] ? String(c["description"]) : null,
            })),
            hint: allRes.rows.length === 0
              ? "No communities detected — run: claude-lore index --force to rebuild"
              : undefined,
          }),
        }],
      };
    },
  );

  // ─── codegraph_search ─────────────────────────────────────────────────────

  server.tool(
    "codegraph_search",
    "Search the structural index for symbol definitions matching a query. Returns symbol names, files, line numbers, and kinds.",
    {
      query:   z.string().describe("Symbol name or partial name to search for"),
      repo:    z.string().optional().describe("Absolute path to the repo root (defaults to cwd)"),
      service: z.string().optional().describe("Scope to a specific service/package"),
    },
    async ({ query, repo }) => {
      const cwd = repo ?? process.cwd();
      const db = getDb(cwd);
      if (!db) return notIndexedError();

      const res = await db.execute({
        sql: `SELECT name, file, start_line, end_line, kind, exported FROM symbols
              WHERE name LIKE '%' || ? || '%'
              ORDER BY
                CASE WHEN name = ? THEN 0
                     WHEN name LIKE ? || '%' THEN 1
                     ELSE 2 END,
                exported DESC,
                LENGTH(name) ASC
              LIMIT 20`,
        args: [query, query, query],
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            query,
            matches: res.rows.map((r) => ({
              name:       String(r["name"]),
              file:       String(r["file"]),
              start_line: Number(r["start_line"]),
              end_line:   Number(r["end_line"]),
              kind:       String(r["kind"]),
              exported:   Number(r["exported"]) === 1,
            })),
            total: res.rows.length,
          }),
        }],
      };
    },
  );

  // ─── codegraph_callers ────────────────────────────────────────────────────

  server.tool(
    "codegraph_callers",
    "Find all symbols that call the given symbol. Returns caller names, files, and call weights.",
    {
      symbol:  z.string().describe("Symbol name to find callers for"),
      repo:    z.string().optional().describe("Absolute path to the repo root (defaults to cwd)"),
      service: z.string().optional().describe("Scope to a specific service/package"),
    },
    async ({ symbol, repo }) => {
      const cwd = repo ?? process.cwd();
      const db = getDb(cwd);
      if (!db) return notIndexedError();

      const res = await db.execute({
        sql: `SELECT DISTINCT cg.caller, cg.caller_file, cg.weight,
                     s.start_line, s.kind, s.exported
              FROM call_graph cg
              LEFT JOIN symbols s ON s.name = cg.caller AND s.file = cg.caller_file
              WHERE cg.callee = ?
              ORDER BY cg.weight DESC
              LIMIT 50`,
        args: [symbol],
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            symbol,
            callers: res.rows.map((r) => ({
              name:   String(r["caller"]),
              file:   String(r["caller_file"] ?? ""),
              line:   r["start_line"] !== null ? Number(r["start_line"]) : null,
              weight: Number(r["weight"] ?? 1),
              kind:   r["kind"] !== null ? String(r["kind"]) : null,
            })),
            total_callers: res.rows.length,
            note: res.rows.length === 50 ? "Results capped at 50 — symbol is widely used" : undefined,
          }),
        }],
      };
    },
  );

  // ─── codegraph_callees ────────────────────────────────────────────────────

  server.tool(
    "codegraph_callees",
    "Find all symbols called by the given symbol. Returns callee names, files, and call weights.",
    {
      symbol:  z.string().describe("Symbol name to find callees for"),
      repo:    z.string().optional().describe("Absolute path to the repo root (defaults to cwd)"),
      service: z.string().optional().describe("Scope to a specific service/package"),
    },
    async ({ symbol, repo }) => {
      const cwd = repo ?? process.cwd();
      const db = getDb(cwd);
      if (!db) return notIndexedError();

      const res = await db.execute({
        sql: `SELECT DISTINCT cg.callee, cg.callee_file, cg.weight,
                     s.start_line, s.kind
              FROM call_graph cg
              LEFT JOIN symbols s ON s.name = cg.callee AND s.file = cg.callee_file
              WHERE cg.caller = ?
              ORDER BY cg.weight DESC
              LIMIT 50`,
        args: [symbol],
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            symbol,
            callees: res.rows.map((r) => ({
              name:   String(r["callee"]),
              file:   r["callee_file"] !== null ? String(r["callee_file"]) : null,
              line:   r["start_line"] !== null ? Number(r["start_line"]) : null,
              weight: Number(r["weight"] ?? 1),
              kind:   r["kind"] !== null ? String(r["kind"]) : null,
            })),
            total_callees: res.rows.length,
          }),
        }],
      };
    },
  );

  // ─── codegraph_impact ─────────────────────────────────────────────────────

  server.tool(
    "codegraph_impact",
    "BFS traversal of the call graph to find all symbols affected if the given symbol changes. Returns impact nodes with hop distance. Also includes test functions that directly cover this symbol (hop=0).",
    {
      symbol:   z.string().describe("Symbol name to analyse impact for"),
      repo:     z.string().optional().describe("Absolute path to the repo root (defaults to cwd)"),
      service:  z.string().optional().describe("Scope to a specific service/package"),
      max_hops: z.number().optional().default(3).describe("Maximum BFS hops (1-5, default 3)"),
    },
    async ({ symbol, repo, max_hops }) => {
      const cwd = repo ?? process.cwd();
      const db = getDb(cwd);
      if (!db) return notIndexedError();

      interface ImpactNode {
        name:   string;
        file:   string;
        hop:    number;
        path:   string[];
        weight: number;
        kind?:  string;
      }

      const maxHops = Math.min(max_hops ?? 3, 5);
      const visited = new Set<string>([symbol]);
      const results: ImpactNode[] = [];

      // Include test functions that directly cover this symbol (hop=0, kind=test_covers)
      const testCoverage = await db.execute({
        sql:  `SELECT DISTINCT caller, caller_file FROM call_graph
               WHERE callee = ? AND kind = 'test_covers'`,
        args: [symbol],
      });
      for (const row of testCoverage.rows) {
        const testName = String(row["caller"]);
        if (!visited.has(testName)) {
          visited.add(testName);
          results.push({
            name:   testName,
            file:   String(row["caller_file"] ?? ""),
            hop:    0,
            path:   [symbol, testName],
            weight: 1,
            kind:   "test_covers",
          });
        }
      }

      // BFS over 'calls' edges to find transitive callers
      let queue: Array<{ name: string; path: string[] }> = [{ name: symbol, path: [symbol] }];

      for (let hop = 1; hop <= maxHops && queue.length > 0; hop++) {
        const names = queue.map((q) => q.name);
        const placeholders = names.map(() => "?").join(",");

        const res = await db.execute({
          sql: `SELECT DISTINCT cg.caller, cg.caller_file, cg.weight, cg.callee
                FROM call_graph cg
                WHERE cg.callee IN (${placeholders}) AND cg.kind = 'calls'`,
          args: names,
        });

        const parentMap = new Map<string, { name: string; path: string[] }>();
        for (const qItem of queue) {
          parentMap.set(qItem.name, qItem);
        }

        const nextQueue: Array<{ name: string; path: string[] }> = [];

        for (const row of res.rows) {
          const caller = String(row["caller"]);
          if (visited.has(caller)) continue;
          visited.add(caller);

          const callee = String(row["callee"]);
          const parent = parentMap.get(callee) ?? queue[0]!;
          const nodePath = [...parent.path, caller];

          results.push({
            name:   caller,
            file:   String(row["caller_file"] ?? ""),
            hop,
            path:   nodePath,
            weight: Number(row["weight"] ?? 1),
          });

          nextQueue.push({ name: caller, path: nodePath });
        }

        queue = nextQueue;
      }

      const maxHopsReached = results.reduce((m, r) => r.hop > m ? r.hop : m, 0);
      const testNodes      = results.filter((r) => r.kind === "test_covers");

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            symbol,
            total_affected:   results.length,
            max_hops_reached: maxHopsReached,
            tests_covering:   testNodes.length,
            impact:           results,
            note: results.length === 0
              ? "No callers found — this symbol may be an entry point or is not yet indexed"
              : undefined,
          }),
        }],
      };
    },
  );

  // ─── codegraph_coverage ───────────────────────────────────────────────────

  server.tool(
    "codegraph_coverage",
    "Get test coverage information for a symbol or file. Returns which test functions cover the symbol, and which symbols in a file have no test coverage.",
    {
      symbol: z.string().optional().describe("Symbol name to check coverage for"),
      file:   z.string().optional().describe("Relative file path to check (alternative to symbol)"),
      repo:   z.string().optional().describe("Absolute path to the repo root (defaults to cwd)"),
    },
    async ({ symbol, file, repo }) => {
      const cwd = repo ?? process.cwd();
      const db  = getDb(cwd);
      if (!db) return notIndexedError();

      if (symbol) {
        const covering = await db.execute({
          sql:  `SELECT caller, caller_file FROM call_graph
                 WHERE callee = ? AND kind = 'test_covers'`,
          args: [symbol],
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              symbol,
              covered_by_tests: covering.rows.length,
              tests:            covering.rows.map((r) => ({
                test_name: String(r["caller"]),
                test_file: String(r["caller_file"] ?? ""),
              })),
              coverage_status: covering.rows.length > 0 ? "covered" : "uncovered",
            }),
          }],
        };
      }

      if (file) {
        const syms = await db.execute({
          sql:  `SELECT name FROM symbols WHERE file = ? AND is_test = 0`,
          args: [file],
        });

        const result = await Promise.all(
          syms.rows.map(async (row) => {
            const name = String(row["name"]);
            const cov  = await db.execute({
              sql:  `SELECT COUNT(*) as c FROM call_graph
                     WHERE callee = ? AND kind = 'test_covers'`,
              args: [name],
            });
            const count = Number(cov.rows[0]?.["c"] ?? 0);
            return { symbol: name, covered: count > 0, test_count: count };
          }),
        );

        const covered   = result.filter((r) => r.covered);
        const uncovered = result.filter((r) => !r.covered);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              file,
              total_symbols:     result.length,
              covered:           covered.length,
              uncovered:         uncovered.length,
              coverage_pct:      result.length > 0
                ? Math.round((covered.length / result.length) * 100)
                : 0,
              uncovered_symbols: uncovered.map((r) => r.symbol),
            }),
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: "provide either symbol or file" }),
        }],
      };
    },
  );

  // ─── analyze_change_risk ──────────────────────────────────────────────────

  server.tool(
    "analyze_change_risk",
    `Analyse the risk of a set of changed symbols by combining structural blast radius (how many things depend on them) with reasoning layer risks (decisions, HIGH/CRITICAL records). Returns a risk score (0-100) per symbol and an overall verdict. Use before committing changes or creating a PR.`,
    {
      symbols: z.array(z.string()).optional().describe(
        "Symbol names to analyse. If omitted, auto-detects from git diff in cwd.",
      ),
      repo:    z.string().optional().describe("Absolute path to the repo root (defaults to cwd)"),
    },
    async ({ symbols, repo }) => {
      const cwd = repo ?? process.cwd();
      const db  = getDb(cwd);
      if (!db) return notIndexedError();

      const structDbPath   = join(cwd, ".codegraph", "structural.db");
      const sessionsDbPath = join(homedir(), ".codegraph", "sessions.db");
      const structDb       = createClient({ url: `file:${structDbPath}` });
      const reasonDb       = createClient({ url: `file:${sessionsDbPath}` });

      let symbolList = symbols ?? [];

      if (symbolList.length === 0) {
        // Auto-detect from git diff
        const { getGitDiff } = await import("../../services/review/renderers/review.js");
        const diffs      = getGitDiff(cwd);
        const filePaths  = diffs.map((d) => d.path);
        symbolList       = await getChangedSymbols(filePaths, structDb);
      }

      if (symbolList.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              verdict:       "low",
              verdict_reason: "no changed symbols found — structural index may need rebuild",
              scores:        [],
            }),
          }],
        };
      }

      const scores  = await scoreChangedSymbols(symbolList.slice(0, 25), cwd, structDb, reasonDb);
      const verdict = deriveVerdict(scores);

      const topScore = scores[0];
      const verdictReason = topScore
        ? `${topScore.symbol} — centrality ${topScore.components.structural_centrality}/40` +
          (topScore.detail.critical_records > 0 ? ` + ${topScore.detail.critical_records} critical risk record(s)` : "") +
          (!topScore.detail.has_test_coverage ? " + no test coverage" : "")
        : "no symbols analysed";

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            verdict,
            verdict_reason: verdictReason,
            scores: scores.map((s) => ({
              symbol:       s.symbol,
              file:         s.file,
              total_score:  s.total_score,
              risk_level:   s.risk_level,
              components:   s.components,
              detail:       s.detail,
            })),
          }),
        }],
      };
    },
  );

  // ─── codegraph_context ────────────────────────────────────────────────────

  server.tool(
    "codegraph_context",
    "Get structural + reasoning context for a task description. Extracts candidate symbols, finds their call relationships, and enriches with reasoning records.",
    {
      task:    z.string().describe("Task description or question — symbol names will be extracted from it"),
      repo:    z.string().optional().describe("Absolute path to the repo root (defaults to cwd)"),
      service: z.string().optional().describe("Scope to a specific service/package"),
    },
    async ({ task, repo }) => {
      const cwd = repo ?? process.cwd();
      const db = getDb(cwd);

      if (!db) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              task,
              primary_symbols: [],
              context:         [],
              note:            "Structural index not built. Run: claude-lore index",
            }),
          }],
        };
      }

      // Extract candidate symbol tokens: camelCase or PascalCase words
      const candidates = task
        .split(/[\s,.()\[\]{};:'"!?]+/)
        .filter((t) => t.length >= 3 && /^[a-z][a-zA-Z0-9]*[A-Z]|^[A-Z][a-z]/.test(t));

      const uniqueCandidates = [...new Set(candidates)].slice(0, 10);

      type SymbolRow = { name: string; file: string; start_line: number; end_line: number; kind: string; exported: number };
      const foundMap = new Map<string, SymbolRow>();

      for (const candidate of uniqueCandidates) {
        const res = await db.execute({
          sql: `SELECT name, file, start_line, end_line, kind, exported FROM symbols
                WHERE name LIKE '%' || ? || '%'
                ORDER BY exported DESC, LENGTH(name) ASC
                LIMIT 2`,
          args: [candidate],
        });
        for (const r of res.rows) {
          const name = String(r["name"]);
          if (!foundMap.has(name)) {
            foundMap.set(name, {
              name,
              file:       String(r["file"]),
              start_line: Number(r["start_line"]),
              end_line:   Number(r["end_line"]),
              kind:       String(r["kind"]),
              exported:   Number(r["exported"]),
            });
          }
        }
      }

      if (foundMap.size === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              task,
              primary_symbols: [],
              context:         [],
              note:            "No matching symbols found. Run: claude-lore index",
            }),
          }],
        };
      }

      const topSymbols = [...foundMap.values()]
        .sort((a, b) => b.exported - a.exported || a.name.length - b.name.length)
        .slice(0, 3);

      const contextItems = await Promise.all(
        topSymbols.map(async (sym) => {
          const [callersRes, calleesRes] = await Promise.all([
            db.execute({
              sql: `SELECT DISTINCT caller FROM call_graph WHERE callee = ? AND kind = 'calls' LIMIT 5`,
              args: [sym.name],
            }),
            db.execute({
              sql: `SELECT DISTINCT callee FROM call_graph WHERE caller = ? AND kind = 'calls' LIMIT 5`,
              args: [sym.name],
            }),
          ]);

          let decisions: unknown[] = [];
          let risks: unknown[] = [];
          let deferred: unknown[] = [];
          try {
            const reasoning = await getReasoningData(sym.name, cwd);
            decisions = reasoning.decisions;
            risks     = reasoning.risks;
            deferred  = reasoning.deferred;
          } catch {
            // ok — reasoning db may not exist
          }

          return {
            symbol:    sym.name,
            file:      sym.file,
            kind:      sym.kind,
            callers:   callersRes.rows.map((r) => String(r["caller"])),
            callees:   calleesRes.rows.map((r) => String(r["callee"])),
            decisions,
            risks,
            deferred,
          };
        }),
      );

      const totalCallers = contextItems.reduce((sum, c) => sum + c.callers.length, 0);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            task,
            primary_symbols: topSymbols.map((s) => s.name),
            context:         contextItems,
            impact_summary:  `Changes here affect ${totalCallers} downstream symbol${totalCallers !== 1 ? "s" : ""} (direct callers only)`,
            note:            "Run claude-lore index to refresh if results seem stale",
          }),
        }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // generate_wiki — generate community wiki pages from the structural index
  // -------------------------------------------------------------------------

  server.tool(
    "generate_wiki",
    "Generate a wiki for the codebase structured by community. Returns community pages with symbols, decisions, risks, and deferred work. Use community= to get a single community page. format=markdown returns rendered Markdown.",
    {
      repo:      z.string().optional().describe("Repo name (used to look up reasoning records). Defaults to cwd basename."),
      community: z.string().optional().describe("Filter to a specific community name or id. Omit for all communities."),
      format:    z.enum(["json", "markdown", "html"]).optional().describe("Output format. Default: json. Use html for self-contained interactive wiki page."),
    },
    async ({ repo, community, format = "json" }) => {
      const cwd = process.cwd();
      const repoId = repo ?? cwd;
      const structDbPath  = join(cwd, ".codegraph", "structural.db");
      const sessionsDbPath = join(homedir(), ".codegraph", "sessions.db");

      if (!existsSync(structDbPath)) {
        return notIndexedError();
      }

      try {
        const structDb = createClient({ url: `file:${structDbPath}` });
        const reasonDb = createClient({ url: `file:${sessionsDbPath}` });
        const pages    = await generateWiki(structDb, reasonDb, repoId);

        const filtered = community
          ? pages.filter(p => p.community_name === community || p.community_id === community)
          : pages;

        if (format === "html") {
          return { content: [{ type: "text" as const, text: renderWikiHtml(pages) }] };
        }

        if (format === "markdown") {
          let md: string;
          if (community) {
            if (filtered.length === 0) {
              return { content: [{ type: "text" as const, text: `Community '${community}' not found.` }] };
            }
            md = renderWikiPageMarkdown(filtered[0]!);
          } else {
            md = renderWikiIndexMarkdown(pages) + "\n\n---\n\n" + pages.map(renderWikiPageMarkdown).join("\n\n---\n\n");
          }
          return { content: [{ type: "text" as const, text: md }] };
        }

        // JSON
        const result = community
          ? { community: filtered[0] ?? null }
          : {
              communities:   pages.length,
              total_symbols: pages.reduce((n, p) => n + p.size, 0),
              generated_at:  pages[0]?.generated_at ?? Date.now(),
              pages:         filtered,
            };

        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }] };
      }
    },
  );
}
