import { sessionsDb } from "../sqlite/db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Task {
  description: string;
  symbols: string[];
  estimated_size: "small" | "medium" | "large";
  dependencies: string[];
}

export interface ParallelGroup {
  tasks: Task[];
  rationale: string;
  safe_because: string[];
  subagent_prompt: string;
}

export interface ParallelismAnalysis {
  repo: string;
  analysed_items: number;
  parallel_groups: ParallelGroup[];
  serial_required: Task[];
  estimated_speedup: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract likely symbol names from a task description (heuristic). */
function extractSymbolHints(description: string): string[] {
  // Capture PascalCase, camelCase, snake_case identifiers longer than 3 chars
  const matches = description.match(/\b[a-zA-Z_][a-zA-Z0-9_]{3,}\b/g) ?? [];
  // Filter out common English words
  const stopWords = new Set([
    "with", "from", "that", "this", "when", "then", "have", "will",
    "should", "would", "could", "into", "also", "only", "each",
    "tests", "test", "update", "refactor", "module", "service",
    "function", "class", "file", "code", "more", "make", "than",
    "need", "using", "used", "being", "done", "add", "remove",
  ]);
  return [...new Set(matches.filter((w) => !stopWords.has(w.toLowerCase())))].slice(0, 5);
}

/** Check if two symbol sets overlap. */
function symbolsOverlap(a: string[], b: string[]): boolean {
  const setA = new Set(a.map((s) => s.toLowerCase()));
  return b.some((s) => setA.has(s.toLowerCase()));
}

/** Check if two task descriptions mention the same file paths (simple heuristic). */
function sameFileMentioned(a: string, b: string): boolean {
  const filePattern = /[\w/-]+\.[a-z]{2,4}/g;
  const filesA = new Set((a.match(filePattern) ?? []).map((f) => f.toLowerCase()));
  if (filesA.size === 0) return false;
  return (b.match(filePattern) ?? []).some((f) => filesA.has(f.toLowerCase()));
}

/** Look up symbols related to a task via session decisions. */
async function enrichTaskSymbols(repo: string, task: Task): Promise<void> {
  if (task.symbols.length > 0) return;
  const hints = extractSymbolHints(task.description);
  if (hints.length === 0) return;

  const enriched: string[] = [];
  for (const hint of hints) {
    const res = await sessionsDb.execute({
      sql: `SELECT DISTINCT symbol FROM decisions
            WHERE repo = ? AND symbol IS NOT NULL AND symbol LIKE ?
            LIMIT 3`,
      args: [repo, `%${hint}%`],
    });
    for (const row of res.rows) {
      const sym = String((row as Record<string, unknown>)["symbol"]);
      enriched.push(sym);
    }
  }
  if (enriched.length > 0) {
    task.symbols = [...new Set([...task.symbols, ...enriched])];
  } else {
    // Fall back to raw hints
    task.symbols = hints;
  }
}

/** Check if a symbol pair has a blast-radius relationship in session data. */
async function hasBlastRadiusRelationship(
  repo: string,
  symsA: string[],
  symsB: string[],
): Promise<boolean> {
  if (symsA.length === 0 || symsB.length === 0) return false;
  // Heuristic: if both symbol sets appear together in the same session observations frequently,
  // they're likely coupled. Check co-occurrence in decisions.
  for (const a of symsA) {
    for (const b of symsB) {
      const res = await sessionsDb.execute({
        sql: `SELECT COUNT(*) as c FROM decisions
              WHERE repo = ? AND (symbol = ? OR symbol = ?)`,
        args: [repo, a, b],
      });
      // If they show up in the same table, they might be related — conservative heuristic
      if (Number((res.rows[0] as Record<string, unknown>)["c"] ?? 0) > 3) return true;
    }
  }
  return false;
}

/** Check blocked_by relationships between deferred items. */
async function getBlockedByMap(repo: string): Promise<Map<string, string>> {
  const res = await sessionsDb.execute({
    sql: `SELECT content, blocked_by FROM deferred_work
          WHERE repo = ? AND status = 'open' AND blocked_by IS NOT NULL AND blocked_by != ''`,
    args: [repo],
  });
  const map = new Map<string, string>();
  for (const row of res.rows) {
    const r = row as Record<string, unknown>;
    map.set(String(r["content"]).slice(0, 80), String(r["blocked_by"]));
  }
  return map;
}

/** Generate a subagent prompt for a group of parallel tasks. */
function generateSubagentPrompt(tasks: Task[], repo: string): string {
  const symbols = [...new Set(tasks.flatMap((t) => t.symbols))];
  const descriptions = tasks.map((t) => `- ${t.description}`).join("\n");
  const symbolList = symbols.length > 0 ? symbols.join(", ") : "general codebase";

  return `You are a focused subagent working on the following task(s) for ${repo}:

${descriptions}

Scope: Only modify files related to [${symbolList}].
Do not modify unrelated modules — this task is being run in parallel with other subagents.

Context to load first:
1. Call reasoning_get(symbol="${symbols[0] ?? ""}") for prior decisions on your symbols.
2. Call session_load("${repo}") for recent session context.

Constraints:
- Only the symbols listed above are in scope for this subagent.
- Do not commit — report what you changed when done.
- If you discover a dependency on another subagent's scope, stop and report it.

When complete:
1. Run tests scoped to the changed files only.
2. Summarise: what changed, which files, any new decisions or risks to log.`;
}

/** Estimate task size from description length and symbol count. */
function estimateSize(description: string, symbols: string[]): "small" | "medium" | "large" {
  const words = description.split(/\s+/).length;
  if (symbols.length > 3 || words > 20) return "large";
  if (words > 10 || symbols.length > 1) return "medium";
  return "small";
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export async function analyseParallelism(
  repo: string,
  taskDescriptions: string[],
): Promise<ParallelismAnalysis> {
  // Build task objects
  const tasks: Task[] = taskDescriptions.map((desc) => ({
    description: desc,
    symbols: [],
    estimated_size: "medium" as const,
    dependencies: [],
  }));

  // Enrich symbols and estimate size
  await Promise.all(tasks.map((t) => enrichTaskSymbols(repo, t)));
  for (const t of tasks) {
    t.estimated_size = estimateSize(t.description, t.symbols);
  }

  // Get blocked_by constraints
  const blockedBy = await getBlockedByMap(repo);

  // Build dependency edges
  for (const task of tasks) {
    const shortContent = task.description.slice(0, 80);
    const blocker = blockedBy.get(shortContent);
    if (blocker) {
      task.dependencies.push(blocker);
    }
  }

  // Determine which tasks must be serial
  const serialSet = new Set<number>();
  const reasons = new Map<number, string[]>();

  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!;
      const b = tasks[j]!;
      const whySerial: string[] = [];

      // Rule 1: overlapping symbols
      if (symbolsOverlap(a.symbols, b.symbols)) {
        whySerial.push("share symbols: " + a.symbols.filter((s) =>
          b.symbols.map((x) => x.toLowerCase()).includes(s.toLowerCase())
        ).join(", "));
      }

      // Rule 2: same file mentioned
      if (sameFileMentioned(a.description, b.description)) {
        whySerial.push("may touch the same file");
      }

      // Rule 3: explicit dependency
      if (a.dependencies.some((d) => b.description.includes(d.slice(0, 20))) ||
          b.dependencies.some((d) => a.description.includes(d.slice(0, 20)))) {
        whySerial.push("explicit blocked_by dependency");
      }

      // Rule 4: blast radius relationship (async check)
      if (whySerial.length === 0) {
        const coupled = await hasBlastRadiusRelationship(repo, a.symbols, b.symbols);
        if (coupled) whySerial.push("symbols are frequently co-changed (possible coupling)");
      }

      if (whySerial.length > 0) {
        serialSet.add(i);
        serialSet.add(j);
        const existingI = reasons.get(i) ?? [];
        existingI.push(...whySerial);
        reasons.set(i, existingI);
        const existingJ = reasons.get(j) ?? [];
        existingJ.push(...whySerial);
        reasons.set(j, existingJ);
      }
    }
  }

  const serialRequired = tasks.filter((_, i) => serialSet.has(i));
  const parallelCandidates = tasks.filter((_, i) => !serialSet.has(i));

  // Group parallel candidates: for now, one group per independent candidate
  // (more sophisticated grouping would cluster by module)
  const parallelGroups: ParallelGroup[] = [];

  // Batch into groups of up to 3
  const BATCH_SIZE = 3;
  for (let i = 0; i < parallelCandidates.length; i += BATCH_SIZE) {
    const batch = parallelCandidates.slice(i, i + BATCH_SIZE);
    const allSymbols = [...new Set(batch.flatMap((t) => t.symbols))];
    parallelGroups.push({
      tasks: batch,
      rationale: `These ${batch.length} task(s) have non-overlapping symbol sets and no dependency relationships.`,
      safe_because: [
        "No shared symbols between tasks",
        "No blocked_by dependencies between tasks",
        "No file overlap detected",
      ],
      subagent_prompt: generateSubagentPrompt(batch, repo),
    });
  }

  // Speedup estimate: serial count + parallel groups vs full serial
  const totalTasks = tasks.length;
  const effectiveSteps = serialRequired.length + parallelGroups.length;
  const speedup = totalTasks > 0 && effectiveSteps > 0
    ? Math.round((totalTasks / effectiveSteps) * 10) / 10
    : 1.0;

  return {
    repo,
    analysed_items: tasks.length,
    parallel_groups: parallelGroups,
    serial_required: serialRequired,
    estimated_speedup: speedup,
  };
}

/** Load open deferred items and run parallelism analysis on them. */
export async function analyseParallelismFromDeferred(
  repo: string,
): Promise<ParallelismAnalysis> {
  const res = await sessionsDb.execute({
    sql: `SELECT content, symbol FROM deferred_work
          WHERE repo = ? AND status = 'open'
          ORDER BY created_at DESC LIMIT 20`,
    args: [repo],
  });

  const tasks = res.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      description: String(r["content"]),
      symbols: r["symbol"] != null ? [String(r["symbol"])] : [],
      estimated_size: "medium" as const,
      dependencies: [],
    };
  });

  if (tasks.length === 0) {
    return {
      repo,
      analysed_items: 0,
      parallel_groups: [],
      serial_required: [],
      estimated_speedup: 1.0,
    };
  }

  const descriptions = tasks.map((t) => t.description);
  return analyseParallelism(repo, descriptions);
}
