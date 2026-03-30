import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function assertWorkerRunning(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error();
  } catch {
    console.error("Worker not running. Start it with: claude-lore worker start");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// advisor gaps
// ---------------------------------------------------------------------------

interface KnowledgeGap {
  type: string;
  description: string;
  symbol?: string;
  score: number;
  age_days?: number;
}

interface GapAdvisory {
  total_gap_score: number;
  priority_gaps: KnowledgeGap[];
  quick_wins: KnowledgeGap[];
}

export async function advisorGaps(): Promise<void> {
  const repo = process.cwd();
  await assertWorkerRunning();

  const url = `${BASE_URL}/api/advisor/gaps?repo=${encodeURIComponent(repo)}&cwd=${encodeURIComponent(repo)}`;
  const res = await fetch(url);
  const data = (await res.json()) as GapAdvisory;

  if (!res.ok) {
    console.error("Error:", JSON.stringify(data));
    process.exit(1);
  }

  if (data.priority_gaps.length === 0 && data.quick_wins.length === 0) {
    console.log("No knowledge gaps detected. The reasoning layer looks complete.");
    return;
  }

  console.log(`\nKnowledge Gap Report  (total score: ${data.total_gap_score})\n`);

  if (data.priority_gaps.length > 0) {
    console.log("PRIORITY GAPS");
    console.log("─".repeat(60));
    for (const g of data.priority_gaps) {
      const sym = g.symbol ? `  [${g.symbol}]` : "";
      const age = g.age_days != null ? `  (${g.age_days}d old)` : "";
      console.log(`  [${g.type}]${sym}${age}  score=${g.score}`);
      console.log(`    ${g.description}`);
    }
    console.log("");
  }

  if (data.quick_wins.length > 0) {
    console.log("QUICK WINS");
    console.log("─".repeat(60));
    for (const g of data.quick_wins) {
      const sym = g.symbol ? `  [${g.symbol}]` : "";
      console.log(`  [${g.type}]${sym}  score=${g.score}`);
      console.log(`    ${g.description}`);
    }
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// advisor claudemd
// ---------------------------------------------------------------------------

interface ClaudeMdFinding {
  type: string;
  description: string;
  line?: number;
  suggestion?: string;
}

interface ClaudeMdAnalysis {
  claude_md_present: boolean;
  token_estimate: number;
  findings: ClaudeMdFinding[];
}

export async function advisorClaudeMd(opts: { apply?: boolean }): Promise<void> {
  const repo = process.cwd();
  await assertWorkerRunning();

  const url = `${BASE_URL}/api/advisor/claudemd?repo=${encodeURIComponent(repo)}&cwd=${encodeURIComponent(repo)}`;
  const res = await fetch(url);
  const data = (await res.json()) as ClaudeMdAnalysis;

  if (!res.ok) {
    console.error("Error:", JSON.stringify(data));
    process.exit(1);
  }

  if (!data.claude_md_present) {
    console.log("No CLAUDE.md found.");
    if (data.findings.length > 0) {
      console.log(`\n  ${data.findings[0]!.suggestion ?? data.findings[0]!.description}`);
    }
    return;
  }

  console.log(`\nCLAUDE.md Analysis  (~${data.token_estimate} tokens)`);

  if (data.findings.length === 0) {
    console.log("  No issues found. CLAUDE.md looks good.");
    return;
  }

  console.log(`  ${data.findings.length} finding(s):\n`);
  for (const f of data.findings) {
    const loc = f.line != null ? ` (line ${f.line})` : "";
    console.log(`  [${f.type}]${loc}`);
    console.log(`    ${f.description}`);
    if (f.suggestion) {
      console.log(`    → ${f.suggestion}`);
    }
    console.log("");
  }

  if (opts.apply) {
    if (data.findings.length === 0) {
      console.log("Nothing to apply.");
      return;
    }
    const applyRes = await fetch(`${BASE_URL}/api/advisor/claudemd/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, cwd: repo, mode: "all" }),
      signal: AbortSignal.timeout(10000),
    });
    if (!applyRes.ok) {
      const err = (await applyRes.json()) as { error: unknown };
      console.error("Apply failed:", JSON.stringify(err.error));
      process.exit(1);
    }
    const result = (await applyRes.json()) as { ok: boolean; applied: number };
    console.log(`✓ Applied ${result.applied} suggestion(s) to CLAUDE.md as HTML comment markers.`);
    console.log("  Review the markers and remove or promote them as appropriate.");
  }
}

// ---------------------------------------------------------------------------
// advisor skills
// ---------------------------------------------------------------------------

interface SkillSuggestion {
  reason: string;
  name: string;
  description: string;
  evidence: string[];
  priority: string;
}

interface SkillGapAnalysis {
  sessions_analysed: number;
  suggestions: SkillSuggestion[];
}

export async function advisorSkills(opts: {
  days?: number;
  generate?: string;
}): Promise<void> {
  const repo = process.cwd();
  const days = opts.days ?? 30;
  await assertWorkerRunning();

  const url = `${BASE_URL}/api/advisor/skills?repo=${encodeURIComponent(repo)}&days=${days}`;
  const res = await fetch(url);
  const data = (await res.json()) as SkillGapAnalysis;

  if (!res.ok) {
    console.error("Error:", JSON.stringify(data));
    process.exit(1);
  }

  console.log(`\nSkill Gap Analysis  (${data.sessions_analysed} sessions, last ${days} days)\n`);

  if (data.suggestions.length === 0) {
    console.log("  No skill gaps detected.");
    return;
  }

  for (const s of data.suggestions) {
    console.log(`  [${s.priority}] ${s.name}  (${s.reason})`);
    console.log(`    ${s.description}`);
    if (s.evidence.length > 0) {
      console.log(`    Evidence:`);
      for (const e of s.evidence.slice(0, 3)) {
        console.log(`      - ${e}`);
      }
    }
    console.log("");
  }

  if (opts.generate) {
    const name = opts.generate;
    const suggestion = data.suggestions.find((s) => s.name === name);
    const description = suggestion?.description ?? `Skill for ${name}`;
    const reason = suggestion?.reason ?? "repeated session pattern";
    const priority = suggestion?.priority ?? "medium";
    const evidence = suggestion?.evidence ?? [];
    const humanName = name.replace(/-/g, " ");

    const evidenceLines = evidence.length > 0
      ? evidence.slice(0, 5).map((e) => `- ${e}`).join("\n")
      : "- (no specific evidence recorded)";

    const scaffold = [
      `---`,
      `description: ${description}`,
      `argument-hint: <symbol or area of code>`,
      `allowed-tools: [Read, Glob, Grep, Bash]`,
      `---`,
      ``,
      `# ${humanName}`,
      ``,
      `<!-- Generated by \`claude-lore advisor skills --generate ${name}\``,
      `     Priority: ${priority} | Reason: ${reason} -->`,
      ``,
      `## When to use`,
      ``,
      `Use this skill when you are about to work on ${humanName}.`,
      `Session history suggests this comes up often enough to benefit from`,
      `a consistent, knowledge-graph-aware approach.`,
      ``,
      `## Evidence from session history`,
      ``,
      evidenceLines,
      ``,
      `## Approach`,
      ``,
      `1. Load prior context`,
      `   \`\`\``,
      `   reasoning_get(symbol="<relevant symbol>", repo="<repo path>")`,
      `   session_load(repo="<repo path>")`,
      `   \`\`\``,
      ``,
      `2. Check for open deferred work related to ${humanName}.`,
      `   If any items are blocking, address them first.`,
      ``,
      `3. Proceed with the task. As you make decisions, record them:`,
      `   \`\`\``,
      `   reasoning_log(type="decision", content="<what was decided and why>",`,
      `                 symbol="<anchored symbol>", repo="<repo path>")`,
      `   \`\`\``,
      ``,
      `4. If you park work for later:`,
      `   \`\`\``,
      `   reasoning_log(type="deferred", content="<what and why deferred>",`,
      `                 symbol="<anchored symbol>", repo="<repo path>")`,
      `   \`\`\``,
      ``,
      `5. If you identify a risk:`,
      `   \`\`\``,
      `   reasoning_log(type="risk", content="<risk description>",`,
      `                 symbol="<anchored symbol>", repo="<repo path>")`,
      `   \`\`\``,
      ``,
      `## After the session`,
      ``,
      `Run \`claude-lore review\` to promote extracted records to confirmed.`,
      ``,
    ].join("\n");

    const skillDir = join(repo, ".claude", "skills");
    mkdirSync(skillDir, { recursive: true });
    const outPath = join(skillDir, `${name}.md`);
    if (existsSync(outPath)) {
      console.log(`Skill already exists: ${outPath}`);
      console.log(`  If you want to regenerate it, delete it first.`);
    } else {
      writeFileSync(outPath, scaffold, "utf8");
      console.log(`✓ Skill scaffold written to: ${outPath}`);
      console.log(`  Edit it to match your team's conventions, then run:`);
      console.log(`    claude-lore skills  (to verify it appears in the manifest)`);
    }
  }
}

// ---------------------------------------------------------------------------
// advisor parallel
// ---------------------------------------------------------------------------

interface ParallelGroup {
  tasks: Array<{ description: string; symbols: string[]; estimated_size: string }>;
  rationale: string;
  safe_because: string[];
  subagent_prompt: string;
}

interface ParallelismAnalysis {
  analysed_items: number;
  parallel_groups: ParallelGroup[];
  serial_required: Array<{ description: string }>;
  estimated_speedup: number;
}

export async function advisorParallel(opts: {
  tasks?: string;
  fromDeferred?: boolean;
}): Promise<void> {
  const repo = process.cwd();
  await assertWorkerRunning();

  let analysis: ParallelismAnalysis;

  if (opts.tasks) {
    const taskList = opts.tasks.split(",").map((t) => t.trim()).filter(Boolean);
    const res = await fetch(`${BASE_URL}/api/advisor/parallel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, tasks: taskList }),
    });
    analysis = (await res.json()) as ParallelismAnalysis;
    if (!res.ok) { console.error("Error:", JSON.stringify(analysis)); process.exit(1); }
  } else {
    const res = await fetch(
      `${BASE_URL}/api/advisor/parallel?repo=${encodeURIComponent(repo)}&from_deferred=true`,
    );
    analysis = (await res.json()) as ParallelismAnalysis;
    if (!res.ok) { console.error("Error:", JSON.stringify(analysis)); process.exit(1); }
  }

  console.log(`\nParallelism Analysis  (${analysis.analysed_items} tasks analysed)\n`);

  if (analysis.analysed_items === 0) {
    console.log("  No tasks to analyse. Add deferred items or pass --tasks.");
    return;
  }

  if (analysis.parallel_groups.length === 0 && analysis.serial_required.length === 0) {
    console.log("  Nothing to parallelise.");
    return;
  }

  if (analysis.parallel_groups.length > 0) {
    console.log(`  Parallel groups: ${analysis.parallel_groups.length}  (estimated ${analysis.estimated_speedup}x speedup)`);
    for (let i = 0; i < analysis.parallel_groups.length; i++) {
      const g = analysis.parallel_groups[i]!;
      console.log(`\n  Group ${i + 1}: ${g.tasks.length} task(s)`);
      console.log(`    Safe because: ${g.safe_because.slice(0, 2).join("; ")}`);
      for (const t of g.tasks) {
        console.log(`    - [${t.estimated_size}] ${t.description.slice(0, 80)}`);
      }
      console.log(`\n  Subagent prompt:`);
      console.log(g.subagent_prompt.split("\n").map((l) => "    " + l).join("\n"));
    }
  }

  if (analysis.serial_required.length > 0) {
    console.log(`\n  Must run serially (${analysis.serial_required.length} task(s)):`);
    for (const t of analysis.serial_required) {
      console.log(`    - ${t.description.slice(0, 80)}`);
    }
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// advisor workflow
// ---------------------------------------------------------------------------

interface WorkflowPattern {
  type: string;
  frequency: number;
  description: string;
  impact: string;
}

interface WorkflowRecommendation {
  priority: string;
  category: string;
  title: string;
  detail: string;
  rationale: string;
}

interface WorkflowAnalysis {
  sessions_analysed: number;
  patterns: WorkflowPattern[];
  recommendations: WorkflowRecommendation[];
}

export async function advisorWorkflow(opts: { days?: number }): Promise<void> {
  const repo = process.cwd();
  const days = opts.days ?? 60;
  await assertWorkerRunning();

  const res = await fetch(
    `${BASE_URL}/api/advisor/workflow?repo=${encodeURIComponent(repo)}&days=${days}`,
  );
  const data = (await res.json()) as WorkflowAnalysis;

  if (!res.ok) { console.error("Error:", JSON.stringify(data)); process.exit(1); }

  console.log(`\nWorkflow Intelligence  (${data.sessions_analysed} sessions, last ${days} days)\n`);

  if (data.sessions_analysed === 0) {
    console.log("  No completed sessions found in this window.");
    return;
  }

  if (data.patterns.length > 0) {
    console.log("  Patterns detected:");
    for (const p of data.patterns) {
      const icon = p.impact === "negative" ? "!" : p.impact === "positive" ? "+" : "~";
      console.log(`    [${icon}] ${p.type}: ${p.description}`);
    }
    console.log("");
  }

  if (data.recommendations.length === 0) {
    console.log("  No workflow recommendations. Working efficiently.");
    return;
  }

  console.log("  Recommendations:");
  for (const r of data.recommendations) {
    console.log(`\n  [${r.priority}/${r.category}] ${r.title}`);
    console.log(`    ${r.detail}`);
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// advisor (top-level summary)
// ---------------------------------------------------------------------------

export async function advisorSummary(opts: { json?: boolean } = {}): Promise<void> {
  const repo = process.cwd();
  await assertWorkerRunning();

  const [gapsRes, claudeRes, skillsRes, parallelRes, workflowRes] = await Promise.allSettled([
    fetch(`${BASE_URL}/api/advisor/gaps?repo=${encodeURIComponent(repo)}&cwd=${encodeURIComponent(repo)}`),
    fetch(`${BASE_URL}/api/advisor/claudemd?repo=${encodeURIComponent(repo)}&cwd=${encodeURIComponent(repo)}`),
    fetch(`${BASE_URL}/api/advisor/skills?repo=${encodeURIComponent(repo)}&days=30`),
    fetch(`${BASE_URL}/api/advisor/parallel?repo=${encodeURIComponent(repo)}&from_deferred=true`),
    fetch(`${BASE_URL}/api/advisor/workflow?repo=${encodeURIComponent(repo)}&days=60`),
  ]);

  const gaps = gapsRes.status === "fulfilled" ? (await gapsRes.value.json()) as GapAdvisory : null;
  const claudeMd = claudeRes.status === "fulfilled" ? (await claudeRes.value.json()) as ClaudeMdAnalysis : null;
  const skills = skillsRes.status === "fulfilled" ? (await skillsRes.value.json()) as SkillGapAnalysis : null;
  const parallel = parallelRes.status === "fulfilled" ? (await parallelRes.value.json()) as ParallelismAnalysis : null;
  const workflow = workflowRes.status === "fulfilled" ? (await workflowRes.value.json()) as WorkflowAnalysis : null;

  if (opts.json) {
    console.log(JSON.stringify({ repo, gaps, claude_md: claudeMd, skills, parallel, workflow }, null, 2));
    return;
  }

  console.log("\nclaude-lore advisor summary\n");

  if (gaps) {
    const icon = gaps.total_gap_score > 30 ? "!" : gaps.total_gap_score > 0 ? "~" : "✓";
    console.log(`  ${icon} Knowledge gaps: score=${gaps.total_gap_score}, priority=${gaps.priority_gaps.length}, quick_wins=${gaps.quick_wins.length}`);
    if (gaps.priority_gaps[0]) {
      console.log(`      Top gap: ${gaps.priority_gaps[0].description.slice(0, 100)}`);
    }
  }

  if (claudeMd) {
    const icon = claudeMd.findings.length > 3 ? "!" : claudeMd.findings.length > 0 ? "~" : "✓";
    console.log(`  ${icon} CLAUDE.md: ~${claudeMd.token_estimate} tokens, ${claudeMd.findings.length} finding(s)`);
    if (claudeMd.findings[0]) {
      console.log(`      Top finding: ${claudeMd.findings[0].description.slice(0, 100)}`);
    }
  }

  if (skills) {
    const icon = skills.suggestions.length > 0 ? "~" : "✓";
    console.log(`  ${icon} Skill gaps: ${skills.suggestions.length} suggestion(s) from ${skills.sessions_analysed} sessions`);
    if (skills.suggestions[0]) {
      console.log(`      Top suggestion: ${skills.suggestions[0].description.slice(0, 100)}`);
    }
  }

  if (parallel) {
    const icon = parallel.parallel_groups.length > 0 ? "~" : "✓";
    console.log(`  ${icon} Parallelism: ${parallel.parallel_groups.length} group(s) from ${parallel.analysed_items} deferred items (${parallel.estimated_speedup}x speedup)`);
  }

  if (workflow) {
    const topRec = workflow.recommendations[0];
    const icon = workflow.recommendations.some((r) => r.priority === "high") ? "!" : workflow.recommendations.length > 0 ? "~" : "✓";
    console.log(`  ${icon} Workflow: ${workflow.sessions_analysed} sessions, ${workflow.recommendations.length} recommendation(s)`);
    if (topRec) {
      console.log(`      Top: ${topRec.title}`);
    }
  }

  console.log("\n  Run sub-commands for details:");
  console.log("    claude-lore advisor gaps");
  console.log("    claude-lore advisor claudemd [--apply]");
  console.log("    claude-lore advisor skills [--days N] [--generate <name>]");
  console.log("    claude-lore advisor parallel [--tasks 't1,t2'] [--from-deferred]");
  console.log("    claude-lore advisor workflow [--days N]");
  console.log("");
}
