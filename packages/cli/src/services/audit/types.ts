// ---------------------------------------------------------------------------
// Audit types — shared across CLI commands and services
// ---------------------------------------------------------------------------

/** A record pulled from the DB that needs audit verification */
export interface ExtractedClaim {
  id: string;
  table: "decisions" | "deferred_work" | "risks";
  type: "decision" | "deferred" | "risk";
  content: string;
  source: string | null;   // md:path:section for bootstrap records
  confidence: string;
  symbol: string | null;
  repo: string;
}

/** Classification after keyword heuristic scan */
export type ClaimKind = "behavioral" | "structural";

/** Result of grep-based verification */
export interface GrepResult {
  matchCount: number;
  matchedFiles: string[];
  /** verified=hits found; ambiguous=partial/unclear; no_code=no hits */
  bucket: "verified" | "ambiguous" | "no_code";
}

/** A claim after grep (and optionally LLM) verification */
export interface VerifiedClaim extends ExtractedClaim {
  kind: ClaimKind;
  grep: GrepResult;
  llmVerified?: boolean;
  llmReasoning?: string;
}

/** A gap detected during audit — will become a pending_review record */
export interface GapRecord {
  /** Existing record being deprecated (null for net-new gaps) */
  replacesId: string | null;
  replacesTable: "decisions" | "deferred_work" | "risks" | null;
  type: "decision" | "deferred" | "risk";
  content: string;
  rationale?: string;
  symbol?: string;
  confidence: "confirmed" | "inferred";
  /** Git context from nearest code touch */
  gitAuthor?: string;
  gitDate?: string;
  gitMessage?: string;
}

/** Breakdown of estimated LLM verification calls by category */
export interface CostBreakdown {
  /** Claims grep fully verifies — no LLM needed */
  grepVerified: number;
  /** Claims grep returns ambiguous hits — LLM needed */
  grepAmbiguous: number;
  /** Claims with no grep hits — LLM needed to confirm absence */
  grepNoCode: number;
  /** Total LLM calls estimated */
  llmCalls: number;
  /** Estimated input tokens across all LLM calls */
  inputTokens: number;
  /** Estimated output tokens across all LLM calls */
  outputTokens: number;
  /** USD cost at claude-sonnet-4 pricing */
  estimatedCostUsd: number;
}

/** Output of --estimate mode */
export interface EstimateResult {
  repoPath: string;
  workerRunning: boolean;
  /** Total source files found (excluding docs, node_modules, etc.) */
  codeFileCount: number;
  /** Markdown/doc files found */
  docFileCount: number;
  /** Existing inferred/extracted records to audit */
  existingRecords: number;
  /** Records classified as behavioral claims */
  behavioralClaims: number;
  /** Records classified as structural/static claims */
  staticClaims: number;
  cost: CostBreakdown;
}

/** Options passed to runAudit() */
export interface AuditOptions {
  repo?: string;
  service?: string;
  estimate?: boolean;
  grepOnly?: boolean;
  resume?: string;
  dryRun?: boolean;
}
