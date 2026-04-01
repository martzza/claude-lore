import type { ExtractedClaim, VerifiedClaim, ClaimKind } from "./types.js";
import { classifyClaim } from "./cost-estimator.js";
import { verifyClaim } from "./grep-verifier.js";
import { getAttributionForFiles } from "./git-historian.js";

export type ClassifiedOutcome =
  | "keep"          // grep verified — record is accurate, no action needed
  | "gap_candidate" // no grep hits — likely a documentation gap
  | "ambiguous"     // one file hit — needs LLM or user confirmation
  | "skip_llm";     // ambiguous, deferred to Phase 4 LLM pass

export interface ClassifiedClaim extends VerifiedClaim {
  outcome: ClassifiedOutcome;
  gitAuthor?: string;
  gitDate?: string;
  gitMessage?: string;
}

export interface ClassifyOptions {
  repoPath: string;
  /** If true, treat ambiguous as gap_candidate (no LLM pass) */
  grepOnly?: boolean;
}

export function classifyRecord(claim: ExtractedClaim, opts: ClassifyOptions): ClassifiedClaim {
  const kind: ClaimKind = classifyClaim(claim.content);
  const grep = verifyClaim(claim.content, { repoPath: opts.repoPath });

  let outcome: ClassifiedOutcome;
  if (grep.bucket === "verified") {
    outcome = "keep";
  } else if (grep.bucket === "ambiguous") {
    outcome = opts.grepOnly ? "gap_candidate" : "skip_llm";
  } else {
    outcome = "gap_candidate";
  }

  // Attach git attribution from the matched files (if any)
  const gitAttr = getAttributionForFiles(grep.matchedFiles);

  return {
    ...claim,
    kind,
    grep,
    outcome,
    gitAuthor:  gitAttr?.author,
    gitDate:    gitAttr?.date,
    gitMessage: gitAttr?.message,
  };
}

/**
 * Classify a batch of claims, returning results sorted by outcome priority:
 * gap_candidate first, then ambiguous, then keep.
 */
export function classifyBatch(claims: ExtractedClaim[], opts: ClassifyOptions): ClassifiedClaim[] {
  const results = claims.map((c) => classifyRecord(c, opts));

  const PRIORITY: Record<ClassifiedOutcome, number> = {
    gap_candidate: 0,
    ambiguous:     1,
    skip_llm:      2,
    keep:          3,
  };

  results.sort((a, b) => PRIORITY[a.outcome] - PRIORITY[b.outcome]);
  return results;
}
