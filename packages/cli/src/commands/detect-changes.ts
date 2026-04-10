import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join, isAbsolute, resolve } from "path";
import { homedir } from "os";

const BASE_URL = "http://127.0.0.1:37778";

function assertWorkerRunning(): void {
  // Worker check happens in the fetch — let the error surface naturally
}

const LEVEL_ICON: Record<string, string> = {
  critical: "CRITICAL",
  high:     "HIGH    ",
  medium:   "MEDIUM  ",
  low:      "LOW     ",
};

const LEVEL_COLOUR: Record<string, string> = {
  critical: "\x1b[31m",  // red
  high:     "\x1b[33m",  // yellow
  medium:   "\x1b[34m",  // blue
  low:      "\x1b[32m",  // green
};

const RESET = "\x1b[0m";

interface RiskScore {
  symbol:       string;
  file:         string;
  total_score:  number;
  risk_level:   "low" | "medium" | "high" | "critical";
  components:   { structural_centrality: number; reasoning_risk: number; test_coverage: number; community_impact: number };
  detail:       { direct_callers: number; transitive_callers: number; has_test_coverage: boolean; communities_affected: string[] };
}

function getLorePath(): { cwd: string; repo: string } {
  const cwd = process.cwd();
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) {
    throw new Error("cwd must be an absolute path");
  }
  // Use last path segment as repo name
  const repo = cwd.split("/").filter(Boolean).pop() ?? cwd;
  return { cwd, repo };
}

export async function runDetectChanges(opts: { staged?: boolean; format?: string }): Promise<void> {
  const format = opts.format ?? "text";
  const { cwd, repo } = getLorePath();

  // Check structural index exists
  const structDbPath = join(cwd, ".codegraph", "structural.db");
  if (!existsSync(structDbPath)) {
    if (format === "json") {
      console.log(JSON.stringify({ error: "structural index not built — run: claude-lore index" }));
    } else {
      console.error("✗ Structural index not found. Run: claude-lore index");
    }
    process.exit(1);
  }

  // Fetch risk scores via worker API (which handles all the DB querying)
  const base = opts.staged ? "index" : "HEAD";
  // For staged: use --cached flag in git diff; we pass base=HEAD and let the worker
  // detect from the diff. For staged-only we'd need a different approach.
  // In practice: detect-changes reads unstaged+staged via HEAD, --staged reads only cached.

  let url = `${BASE_URL}/api/review/diff?repo=${encodeURIComponent(repo)}&cwd=${encodeURIComponent(cwd)}&format=json&base=HEAD`;

  if (opts.staged) {
    // Get staged files via git, then score them directly
    await runDetectStaged(cwd, repo, format);
    return;
  }

  let data: {
    changed_files: Array<{ path: string; status: string; lines_added: number; lines_removed: number }>;
    risk_scores:   RiskScore[];
    verdict:       string;
    verdict_reason: string;
  };

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Worker returned ${res.status}`);
    }
    data = await res.json() as typeof data;
  } catch (err) {
    console.error("✗ Could not reach worker:", err);
    console.error("  Is the worker running? Try: claude-lore worker start");
    process.exit(1);
  }

  if (format === "json") {
    console.log(JSON.stringify({
      verdict:       data.verdict,
      verdict_reason: data.verdict_reason,
      scores:        data.risk_scores,
      changed_files: data.changed_files,
    }, null, 2));
    return;
  }

  // Text output
  const scores = data.risk_scores ?? [];
  const files  = data.changed_files ?? [];

  if (files.length === 0 && scores.length === 0) {
    console.log("No changed files detected.");
    return;
  }

  const repoName = cwd.split("/").filter(Boolean).pop() ?? cwd;
  console.log(`\nAnalysing changes in ${repoName}...`);
  console.log("─".repeat(55));

  if (scores.length === 0) {
    console.log(`\nChanged files: ${files.length}`);
    for (const f of files) {
      console.log(`  ${f.status.toUpperCase().padEnd(8)} ${f.path}`);
    }
    console.log("\nNo symbols found in structural index for changed files.");
    console.log("Run: claude-lore index --force to rebuild the index");
    return;
  }

  console.log(`\nChanged symbols: ${scores.length}`);

  for (const s of scores) {
    const colour = LEVEL_COLOUR[s.risk_level] ?? "";
    const icon   = LEVEL_ICON[s.risk_level]   ?? s.risk_level;
    console.log(`\n  ${colour}${icon}${RESET}  ${s.symbol.padEnd(30)} score: ${s.total_score}`);

    const callers = s.detail.transitive_callers;
    let detail = `            ${callers} transitive caller${callers !== 1 ? "s" : ""}`;
    if (s.detail.critical_records > 0) {
      detail += ` · CRITICAL risk ×${s.detail.critical_records}`;
    }
    if (!s.detail.has_test_coverage) {
      detail += " · no tests";
    } else {
      detail += " · tests: covered";
    }
    console.log(detail);

    if (s.detail.communities_affected.length > 0) {
      console.log(`            Communities: ${s.detail.communities_affected.join(", ")}`);
    }
  }

  console.log("\n" + "─".repeat(55));

  const colour = LEVEL_COLOUR[data.verdict] ?? "";
  console.log(`VERDICT: ${colour}${data.verdict.toUpperCase()}${RESET}`);
  if (data.verdict_reason) {
    console.log(`  ${data.verdict_reason}`);
  }

  if (data.verdict === "critical" || data.verdict === "high") {
    const uncovered = scores.filter((s) => !s.detail.has_test_coverage && s.total_score >= 30);
    if (uncovered.length > 0) {
      console.log(`\n  ⚠  Tests missing on: ${uncovered.map((s) => s.symbol).join(", ")}`);
      console.log("     Consider adding tests before merging.");
    }
  }

  console.log("");
}

async function runDetectStaged(cwd: string, repo: string, format: string): Promise<void> {
  // Get staged file paths
  let stagedFiles: string[] = [];
  try {
    const output = execFileSync("git", ["-C", cwd, "diff", "--cached", "--name-only"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    stagedFiles = output ? output.split("\n").filter(Boolean) : [];
  } catch { /* ok */ }

  if (stagedFiles.length === 0) {
    if (format === "json") {
      console.log(JSON.stringify({ verdict: "low", scores: [], changed_files: [], verdict_reason: "no staged files" }));
    } else {
      console.log("No staged changes found.");
    }
    return;
  }

  // Use the API with those files — pass a comma-separated query param
  const filesParam = stagedFiles.map((f) => encodeURIComponent(f)).join(",");
  const url = `${BASE_URL}/api/review/diff?repo=${encodeURIComponent(repo)}&cwd=${encodeURIComponent(cwd)}&format=json&base=HEAD`;

  try {
    const res  = await fetch(url);
    const data = await res.json() as {
      changed_files: Array<{ path: string; status: string; lines_added: number; lines_removed: number }>;
      risk_scores:   RiskScore[];
      verdict:       string;
      verdict_reason: string;
    };

    // Filter to staged files only
    const stagedSet = new Set(stagedFiles);
    const filteredFiles  = (data.changed_files ?? []).filter((f) => stagedSet.has(f.path));
    const filteredScores = (data.risk_scores ?? []).filter((s) => stagedFiles.some((f) => f.includes(s.file) || s.file.includes(f.split("/").pop()!)));

    if (format === "json") {
      console.log(JSON.stringify({ verdict: data.verdict, verdict_reason: data.verdict_reason, scores: filteredScores, changed_files: filteredFiles }, null, 2));
    } else {
      // Reuse the text renderer by delegating to the full run with filtered data
      const scores = filteredScores;
      if (scores.length === 0) {
        console.log("No symbols found in staged changes.");
        return;
      }
      console.log(`\nStaged changes — ${scores.length} symbols:\n`);
      for (const s of scores) {
        const colour = LEVEL_COLOUR[s.risk_level] ?? "";
        console.log(`  ${colour}${LEVEL_ICON[s.risk_level]}${RESET}  ${s.symbol} (score: ${s.total_score})`);
      }
      const colour = LEVEL_COLOUR[data.verdict] ?? "";
      console.log(`\nVERDICT: ${colour}${data.verdict.toUpperCase()}\x1b[0m — ${data.verdict_reason}\n`);
    }
  } catch (err) {
    console.error("✗ Could not reach worker:", err);
    process.exit(1);
  }
}
