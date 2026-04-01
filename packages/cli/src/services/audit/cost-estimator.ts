import { readdirSync, statSync, existsSync, readFileSync } from "fs";
import { join, extname } from "path";
import type { ExtractedClaim, ClaimKind, CostBreakdown, EstimateResult } from "./types.js";

// ---------------------------------------------------------------------------
// Pricing (claude-sonnet-4-6, per million tokens)
// ---------------------------------------------------------------------------

const INPUT_PRICE_PER_M = 3.0;   // USD
const OUTPUT_PRICE_PER_M = 15.0; // USD

// Tokens per LLM verification call (code snippet + claim + prompt / JSON output)
const TOKENS_PER_VERIFY_INPUT = 600;
const TOKENS_PER_VERIFY_OUTPUT = 120;

// ---------------------------------------------------------------------------
// Behavioral keyword detection
// ---------------------------------------------------------------------------

const BEHAVIORAL_PATTERNS = [
  /\b(always|never|must|should not|must not)\b/i,
  /\b(validates?|ensures?|guards?|rejects?|throws?|raises?)\b/i,
  /\b(returns?|responds? with|emits?|fires?)\b/i,
  /\b(fails? when|fails? if|errors? when|errors? if)\b/i,
  /\b(requires?|enforces?|prevents?|disallows?)\b/i,
  /\b(rate.?limit|auth|authoris|permission|access control)\b/i,
  /\b(on (success|failure|error|timeout)|before|after)\b/i,
];

export function classifyClaim(content: string): ClaimKind {
  for (const re of BEHAVIORAL_PATTERNS) {
    if (re.test(content)) return "behavioral";
  }
  return "structural";
}

// ---------------------------------------------------------------------------
// Cost calculation
// ---------------------------------------------------------------------------

/**
 * Given counts of claim kinds and rough grep bucket ratios, produce cost breakdown.
 *
 * Grep bucket assumptions:
 *   behavioral: 55% verified, 30% ambiguous, 15% no_code
 *   structural:  75% verified, 15% ambiguous, 10% no_code
 *
 * LLM is only called for ambiguous + no_code behavioral claims.
 * Structural no-code claims are surfaced as likely gaps without LLM.
 */
export function estimateCost(behavioralCount: number, staticCount: number): CostBreakdown {
  const bVerified  = Math.round(behavioralCount * 0.55);
  const bAmbiguous = Math.round(behavioralCount * 0.30);
  const bNoCode    = behavioralCount - bVerified - bAmbiguous;

  const sVerified  = Math.round(staticCount * 0.75);
  const sAmbiguous = Math.round(staticCount * 0.15);
  const sNoCode    = staticCount - sVerified - sAmbiguous;

  const grepVerified  = bVerified + sVerified;
  const grepAmbiguous = bAmbiguous + sAmbiguous;
  const grepNoCode    = bNoCode + sNoCode;

  // LLM is called for: all behavioral ambiguous/no_code + structural ambiguous
  const llmCalls = bAmbiguous + bNoCode + sAmbiguous;

  const inputTokens  = llmCalls * TOKENS_PER_VERIFY_INPUT;
  const outputTokens = llmCalls * TOKENS_PER_VERIFY_OUTPUT;

  const estimatedCostUsd =
    (inputTokens  / 1_000_000) * INPUT_PRICE_PER_M +
    (outputTokens / 1_000_000) * OUTPUT_PRICE_PER_M;

  return {
    grepVerified,
    grepAmbiguous,
    grepNoCode,
    llmCalls,
    inputTokens,
    outputTokens,
    estimatedCostUsd,
  };
}

// ---------------------------------------------------------------------------
// File counting
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage",
  ".codegraph", ".next", ".turbo", "out", ".cache",
]);

const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".rb", ".cs", ".cpp", ".c", ".h",
]);

interface FileCounts {
  codeFiles: number;
  docFiles: number;
}

function countFiles(dir: string): FileCounts {
  let codeFiles = 0;
  let docFiles = 0;

  function walk(current: string): void {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(current, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(full);
      } else {
        const ext = extname(entry).toLowerCase();
        if (CODE_EXTS.has(ext)) codeFiles++;
        else if (ext === ".md" || ext === ".mdx") docFiles++;
      }
    }
  }

  walk(dir);
  return { codeFiles, docFiles };
}

// ---------------------------------------------------------------------------
// Worker API helpers
// ---------------------------------------------------------------------------

const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function isWorkerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

interface PendingRecord {
  id: string;
  table: string;
  type: string;
  content: string;
  source?: string;
  symbol: string | null;
  repo: string;
  confidence: string;
}

async function fetchInferredRecords(repo: string, service?: string): Promise<ExtractedClaim[]> {
  const params = new URLSearchParams({ repo });
  if (service) params.set("service", service);

  const res = await fetch(`${BASE_URL}/api/records/pending?${params}`, {
    signal: AbortSignal.timeout(5000),
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

// ---------------------------------------------------------------------------
// Main estimate function
// ---------------------------------------------------------------------------

export async function runEstimate(repoPath: string, service?: string): Promise<EstimateResult> {
  const workerRunning = await isWorkerRunning();

  const { codeFiles, docFiles } = countFiles(repoPath);

  let existingRecords = 0;
  let behavioralClaims = 0;
  let staticClaims = 0;

  if (workerRunning) {
    const claims = await fetchInferredRecords(repoPath, service);
    existingRecords = claims.length;
    for (const claim of claims) {
      if (classifyClaim(claim.content) === "behavioral") {
        behavioralClaims++;
      } else {
        staticClaims++;
      }
    }
  }

  const cost = estimateCost(behavioralClaims, staticClaims);

  return {
    repoPath,
    workerRunning,
    codeFileCount: codeFiles,
    docFileCount: docFiles,
    existingRecords,
    behavioralClaims,
    staticClaims,
    cost,
  };
}
