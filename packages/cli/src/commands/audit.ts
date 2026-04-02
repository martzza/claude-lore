import { createInterface } from "readline";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AuditOptions, EstimateResult, ExtractedClaim, GapRecord } from "../services/audit/types.js";
import { runEstimate } from "../services/audit/cost-estimator.js";
import { classifyBatch, type ClassifiedClaim } from "../services/audit/record-classifier.js";
import { verifyBatch, summariseCost, type BatchVerifyResult } from "../services/audit/llm-verifier.js";
import { buildClaudeMdWizard, writeClaudeMd } from "../claude-md.js";

const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";
const BASE_URL = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function assertWorkerRunning(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error();
  } catch {
    console.error("Worker not running. Start it with: claude-lore worker start");
    process.exit(1);
  }
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

// ---------------------------------------------------------------------------
// Worker API calls
// ---------------------------------------------------------------------------

interface PendingRecord {
  id: string;
  table: string;
  type: string;
  content: string;
  symbol: string | null;
  repo: string;
  confidence: string;
}

async function fetchInferredRecords(repo: string, service?: string): Promise<ExtractedClaim[]> {
  const params = new URLSearchParams({ repo });
  if (service) params.set("service", service);
  const res = await fetch(`${BASE_URL}/api/records/pending?${params}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { records: PendingRecord[] };
  return body.records.map((r) => ({
    id: r.id,
    table: r.table as ExtractedClaim["table"],
    type: r.type as ExtractedClaim["type"],
    content: r.content,
    source: (r as Record<string, unknown>)["source"] as string | null ?? null,
    confidence: r.confidence,
    symbol: r.symbol,
    repo: r.repo,
  }));
}

async function startAuditRun(repo: string, mode: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/audit/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, mode }),
  });
  const body = (await res.json()) as { audit_id: string };
  return body.audit_id;
}

async function completeAuditRun(
  auditId: string,
  stats: { claimsFound: number; behavioralClaims: number; gapsFound: number; recordsCreated: number; recordsDeprecated: number },
  status: "completed" | "partial" = "completed",
): Promise<void> {
  await fetch(`${BASE_URL}/api/audit/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audit_id: auditId,
      status,
      claims_found: stats.claimsFound,
      behavioral_claims: stats.behavioralClaims,
      gaps_found: stats.gapsFound,
      records_created: stats.recordsCreated,
      records_deprecated: stats.recordsDeprecated,
    }),
  });
}

async function writeGapRecord(auditId: string, gap: GapRecord, repo: string): Promise<string | null> {
  const res = await fetch(`${BASE_URL}/api/audit/write-gap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repo,
      audit_id: auditId,
      type: gap.type,
      content: gap.content,
      rationale: gap.rationale,
      symbol: gap.symbol,
      confidence: gap.confidence,
      pending_review: true,
      replaces: gap.replacesId ?? undefined,
      git_author: gap.gitAuthor,
      git_date: gap.gitDate,
      git_message: gap.gitMessage,
    }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function dismissRecord(id: string, table: string): Promise<void> {
  await fetch(`${BASE_URL}/api/records/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, table, action: "dismiss" }),
  });
}

// ---------------------------------------------------------------------------
// Resume state (saved to ~/.codegraph/audit-{id}.json)
// ---------------------------------------------------------------------------

interface AuditState {
  auditId: string;
  repo: string;
  processedIds: string[];
  stats: {
    claimsFound: number;
    behavioralClaims: number;
    gapsFound: number;
    recordsCreated: number;
    recordsDeprecated: number;
  };
}

function stateFilePath(auditId: string): string {
  return join(homedir(), ".codegraph", `audit-${auditId}.json`);
}

function loadState(auditId: string): AuditState | null {
  const path = stateFilePath(auditId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AuditState;
  } catch {
    return null;
  }
}

function saveState(state: AuditState): void {
  try {
    writeFileSync(stateFilePath(state.auditId), JSON.stringify(state, null, 2));
  } catch {}
}

function deleteState(auditId: string): void {
  try {
    const { unlinkSync } = require("fs");
    unlinkSync(stateFilePath(auditId));
  } catch {}
}

// ---------------------------------------------------------------------------
// --estimate display
// ---------------------------------------------------------------------------

function printEstimate(est: EstimateResult): void {
  console.log("\nclaude-lore audit — cost estimate\n");
  console.log(`  Repo            ${est.repoPath}`);
  console.log(`  Code files      ${est.codeFileCount}`);
  console.log(`  Doc files       ${est.docFileCount}`);
  console.log(`  Worker          ${est.workerRunning ? "running" : "not running"}`);

  if (!est.workerRunning) {
    console.log("\n  Cannot estimate record counts — worker is not running.");
    console.log("  Start it with: claude-lore worker start\n");
    return;
  }

  console.log(`\n  Records to audit   ${est.existingRecords}`);
  console.log(`    behavioral       ${est.behavioralClaims}  (requires grep + possible LLM)`);
  console.log(`    structural       ${est.staticClaims}  (grep only)`);

  console.log("\n  Verification breakdown (estimated)");
  console.log(`    grep verified    ${est.cost.grepVerified}  (no LLM needed)`);
  console.log(`    grep ambiguous   ${est.cost.grepAmbiguous}  (LLM confirms)`);
  console.log(`    no code hits     ${est.cost.grepNoCode}  (LLM checks absence)`);

  console.log("\n  LLM cost estimate");
  console.log(`    calls            ~${est.cost.llmCalls}`);
  console.log(`    input tokens     ~${est.cost.inputTokens.toLocaleString()}`);
  console.log(`    output tokens    ~${est.cost.outputTokens.toLocaleString()}`);

  const cents = est.cost.estimatedCostUsd * 100;
  const display = cents < 1 ? `< $0.01` : `$${est.cost.estimatedCostUsd.toFixed(3)}`;
  console.log(`    estimated cost   ${display}  (claude-sonnet-4)`);

  if (est.existingRecords === 0) {
    console.log("\n  No inferred/extracted records found. Run bootstrap first:");
    console.log("    claude-lore bootstrap\n");
  } else {
    console.log("\n  Run the full audit with:");
    console.log("    claude-lore audit\n");
  }
}

// ---------------------------------------------------------------------------
// Interactive gap review (page of 5)
// ---------------------------------------------------------------------------

const PAGE_SIZE = 5;

function renderClaim(c: ClassifiedClaim, idx: number, total: number): void {
  const sym = c.symbol ? ` [${c.symbol}]` : "";
  const files = c.grep.matchedFiles.length > 0
    ? `  grep: ${c.grep.matchedFiles.slice(0, 3).map((f) => f.split("/").slice(-2).join("/")).join(", ")}${c.grep.matchedFiles.length > 3 ? ` +${c.grep.matchedFiles.length - 3}` : ""}`
    : "  grep: no code hits";
  const badge = c.llmVerified ? "LLM:GAP" : c.grep.bucket === "no_code" ? "NO HITS" : "AMBIGUOUS";

  console.log(`\n[${idx}/${total}] ${c.type}  (${c.confidence})  [${badge}]${sym}`);
  console.log(`  ${c.content.slice(0, 200)}${c.content.length > 200 ? "…" : ""}`);
  console.log(files);
  if (c.llmReasoning) {
    console.log(`  llm:  ${c.llmReasoning.slice(0, 120)}`);
  }
  if (c.gitAuthor) {
    console.log(`  git:  ${c.gitAuthor}${c.gitDate ? ` (${c.gitDate})` : ""}${c.gitMessage ? ` — "${c.gitMessage.slice(0, 80)}"` : ""}`);
  }
}

async function reviewGapPage(
  gaps: ClassifiedClaim[],
  pageStart: number,
  auditId: string,
  repo: string,
  state: AuditState,
  dryRun: boolean,
): Promise<{ done: boolean; quit: boolean }> {
  const page = gaps.slice(pageStart, pageStart + PAGE_SIZE);
  const total = gaps.length;

  console.log(`\n  [g] write gap   [d] dismiss (bootstrap was wrong)   [s] skip   [q] save & quit`);

  for (let i = 0; i < page.length; i++) {
    const c = page[i]!;
    renderClaim(c, pageStart + i + 1, total);

    const answer = await prompt("> ");

    if (answer === "q") {
      console.log(`\nAudit paused. Resume with: claude-lore audit --resume ${auditId}\n`);
      saveState(state);
      return { done: false, quit: true };
    }

    if (answer === "g") {
      const extraReasoning = await prompt("  Add reasoning (or enter to skip): ");
      const gap: GapRecord = {
        replacesId: c.id,
        replacesTable: c.table,
        type: c.type,
        content: c.content,
        rationale: extraReasoning || undefined,
        symbol: c.symbol ?? undefined,
        confidence: "inferred",
        gitAuthor: c.gitAuthor,
        gitDate: c.gitDate,
        gitMessage: c.gitMessage,
      };

      if (!dryRun) {
        const newId = await writeGapRecord(auditId, gap, repo);
        if (newId) {
          console.log("  ✓ gap written (pending_review=1)\n");
          state.stats.recordsCreated++;
          state.stats.recordsDeprecated++;
          state.stats.gapsFound++;
        } else {
          console.log("  ! failed to write gap record\n");
        }
      } else {
        console.log("  (dry-run) gap would be written\n");
        state.stats.gapsFound++;
      }
    } else if (answer === "d") {
      if (!dryRun) {
        await dismissRecord(c.id, c.table);
        console.log("  ✗ dismissed (record marked as deprecated)\n");
        state.stats.recordsDeprecated++;
      } else {
        console.log("  (dry-run) record would be dismissed\n");
      }
    } else {
      console.log("  → skipped\n");
    }

    state.processedIds.push(c.id);
    saveState(state);
  }

  return { done: pageStart + PAGE_SIZE >= total, quit: false };
}

// ---------------------------------------------------------------------------
// Full audit flow
// ---------------------------------------------------------------------------

// Returns content snippets from grep-verified records for use as CLAUDE.md hints.
async function runFullAudit(opts: AuditOptions & { repo: string }): Promise<string[]> {
  const { repo, service, grepOnly = false, dryRun = false, resume } = opts;
  const mode = grepOnly ? "grep_only" : "full";

  console.log(`\nclaude-lore audit${dryRun ? " (dry-run)" : ""}${grepOnly ? " (grep-only)" : ""}\n`);

  // Restore or start audit run
  let state: AuditState;
  if (resume) {
    const saved = loadState(resume);
    if (!saved) {
      console.error(`No saved audit state found for id: ${resume}`);
      process.exit(1);
    }
    state = saved;
    console.log(`Resuming audit ${resume} (${saved.processedIds.length} records already processed)\n`);
  } else {
    const auditId = dryRun ? `dry-${Date.now()}` : await startAuditRun(repo, mode);
    state = {
      auditId,
      repo,
      processedIds: [],
      stats: { claimsFound: 0, behavioralClaims: 0, gapsFound: 0, recordsCreated: 0, recordsDeprecated: 0 },
    };
  }

  // Fetch records to audit
  console.log("Fetching inferred records...");
  const allClaims = await fetchInferredRecords(repo, service);

  // Filter already-processed records (for resume)
  const processed = new Set(state.processedIds);
  const claims = allClaims.filter((c) => !processed.has(c.id));

  state.stats.claimsFound = allClaims.length;

  if (claims.length === 0) {
    console.log("No inferred/extracted records to audit.");
    if (allClaims.length === 0) {
      console.log("Run bootstrap first: claude-lore bootstrap\n");
    } else {
      console.log("All records have been processed.\n");
    }
    return [];
  }

  console.log(`Classifying ${claims.length} record${claims.length !== 1 ? "s" : ""} via grep...`);

  const classified = classifyBatch(claims, { repoPath: repo, grepOnly });

  const kept       = classified.filter((c) => c.outcome === "keep");
  const gaps       = classified.filter((c) => c.outcome === "gap_candidate");
  const needsLlm   = classified.filter((c) => c.outcome === "skip_llm");

  state.stats.behavioralClaims = classified.filter((c) => c.kind === "behavioral").length;

  console.log(`\n  grep verified    ${kept.length}  (no action needed)`);
  console.log(`  gap candidates   ${gaps.length}  (no code evidence found)`);
  console.log(`  ambiguous        ${needsLlm.length}  (single file hit${grepOnly ? ", treating as gap" : ", queued for LLM"})`);

  // LLM pass — verify ambiguous claims when not in grep-only mode
  let llmPromoted: ClassifiedClaim[] = [];
  let llmVerified: ClassifiedClaim[] = [];

  if (!grepOnly && needsLlm.length > 0) {
    const hasKey = !!process.env["ANTHROPIC_API_KEY"];
    if (!hasKey) {
      console.log(`\n  ANTHROPIC_API_KEY not set — treating ${needsLlm.length} ambiguous record${needsLlm.length !== 1 ? "s" : ""} as gap candidates.`);
      console.log("  Set the key or use --grep-only to suppress this message.");
      llmPromoted = needsLlm;
    } else {
      console.log(`\n  Running LLM verification on ${needsLlm.length} ambiguous record${needsLlm.length !== 1 ? "s" : ""}...`);
      let done = 0;
      const batchResults: BatchVerifyResult[] = await verifyBatch(needsLlm, (n, total) => {
        done = n;
        process.stdout.write(`\r  ${n}/${total} verified`);
      });
      process.stdout.write("\n");

      const cost = summariseCost(batchResults);
      console.log(`  LLM cost: ${batchResults.length} calls, ~${cost.inputTokens.toLocaleString()} in / ${cost.outputTokens.toLocaleString()} out tokens, ~$${cost.estimatedUsd.toFixed(4)}`);

      for (const { claim, llmResult } of batchResults) {
        if (llmResult.verdict === "verified") {
          llmVerified.push(claim);
        } else if (llmResult.verdict === "gap") {
          // Attach LLM reasoning to the claim for display
          llmPromoted.push({ ...claim, llmVerified: true, llmReasoning: llmResult.reasoning });
        } else {
          // unknown — skip quietly
        }
      }
      console.log(`  LLM: ${llmVerified.length} confirmed, ${llmPromoted.length} promoted to gap, ${batchResults.length - llmVerified.length - llmPromoted.length} unknown (skipped)`);
    }
  }

  const toReview = grepOnly ? [...gaps, ...needsLlm] : [...gaps, ...llmPromoted];

  if (toReview.length === 0) {
    console.log("\nNo gaps detected — all records have code backing.\n");
    if (!dryRun) {
      await completeAuditRun(state.auditId, state.stats);
    }
    deleteState(state.auditId);
    return keptHints(kept);
  }

  console.log(`\n${toReview.length} gap candidate${toReview.length !== 1 ? "s" : ""} to review (${PAGE_SIZE} per page)\n`);

  let pageStart = 0;
  while (pageStart < toReview.length) {
    const { done, quit } = await reviewGapPage(
      toReview,
      pageStart,
      state.auditId,
      repo,
      state,
      dryRun,
    );

    if (quit) {
      if (!dryRun) await completeAuditRun(state.auditId, state.stats, "partial");
      return [];
    }

    if (done) break;

    pageStart += PAGE_SIZE;
    const remaining = toReview.length - pageStart;
    if (remaining > 0) {
      const next = await prompt(`\n  ${remaining} more gap${remaining !== 1 ? "s" : ""} — continue? [y/n/q] `);
      if (next === "n" || next === "q") {
        console.log(`\nAudit paused. Resume with: claude-lore audit --resume ${state.auditId}\n`);
        saveState(state);
        if (!dryRun) await completeAuditRun(state.auditId, state.stats, "partial");
        return;
      }
    }
  }

  // Completed
  console.log(`\nAudit complete`);
  console.log(`  gaps written       ${state.stats.recordsCreated}`);
  console.log(`  records deprecated ${state.stats.recordsDeprecated}`);

  if (llmVerified.length > 0) {
    console.log(`  llm confirmed      ${llmVerified.length}  (ambiguous but code-backed)`);
  }
  console.log();

  if (!dryRun) {
    await completeAuditRun(state.auditId, state.stats);
    deleteState(state.auditId);
  }

  // Surface gap records for review
  if (state.stats.recordsCreated > 0) {
    console.log(`  ${state.stats.recordsCreated} gap record${state.stats.recordsCreated !== 1 ? "s" : ""} are pending review.`);
    console.log("  Review them with: claude-lore review\n");
  }

  return keptHints(kept);
}

// Extract short, human-readable hints from grep-verified records to seed
// CLAUDE.md convention suggestions.
function keptHints(kept: ClassifiedClaim[]): string[] {
  return kept
    .filter((c) => c.type === "decision" && c.content.length < 120)
    .slice(0, 5)
    .map((c) => c.content.trim());
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function auditPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

export async function runAudit(opts: AuditOptions = {}): Promise<void> {
  const repo = opts.repo ?? process.cwd();

  if (opts.estimate) {
    const est = await runEstimate(repo, opts.service);
    printEstimate(est);
    return;
  }

  await assertWorkerRunning();
  const verifiedHints = await runFullAudit({ ...opts, repo });

  // ── CLAUDE.md step ─────────────────────────────────────────────────────────
  const claudeMdPath = join(repo, "CLAUDE.md");

  if (!existsSync(claudeMdPath)) {
    console.log("─────────────────────────────────────────────────────────");
    console.log("  No CLAUDE.md found.");
    console.log("  The audit has verified which records are code-backed.");
    console.log("  Build a CLAUDE.md now using those findings as a starting point?");
    const answer = await auditPrompt("  [Y/n]: ");
    if (answer.toLowerCase() !== "n") {
      const content = await buildClaudeMdWizard(repo, auditPrompt, verifiedHints);
      if (content) writeClaudeMd(claudeMdPath, content);
    }
  } else {
    // CLAUDE.md exists — nudge toward the advisor check
    console.log("  CLAUDE.md exists. Run \`/lore improve\` to check for sections that");
    console.log("  duplicate knowledge graph records (frees up per-session tokens).\n");
  }
}
