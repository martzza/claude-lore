import { readFileSync, existsSync } from "fs";
import type { ClassifiedClaim } from "./record-classifier.js";
import { extractKeywords } from "./grep-verifier.js";

// ---------------------------------------------------------------------------
// Strip confidence prefixes injected by applyConfidencePrefix()
// ---------------------------------------------------------------------------

const PREFIXES = [
  /^session records suggest:\s*/i,
  /^inferred from documentation:\s*/i,
  /^conflicting records exist:\s*/i,
];

export function stripConfidencePrefix(content: string): string {
  for (const re of PREFIXES) {
    if (re.test(content)) return content.replace(re, "");
  }
  return content;
}

// ---------------------------------------------------------------------------
// Code snippet extraction
// ---------------------------------------------------------------------------

const MAX_SNIPPET_BYTES = 6000; // ~1500 tokens — cap per file to control costs

/**
 * Read up to MAX_SNIPPET_BYTES from a file, centred around the first match
 * of any of the provided search terms (if terms are given).
 */
export function readCodeSnippet(filePath: string, terms: string[] = []): string {
  if (!existsSync(filePath)) return "";

  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return "";
  }

  if (content.length <= MAX_SNIPPET_BYTES) return content;

  // Try to centre around the first hit
  if (terms.length > 0) {
    for (const term of terms) {
      const idx = content.indexOf(term);
      if (idx !== -1) {
        const start = Math.max(0, idx - MAX_SNIPPET_BYTES / 2);
        const end = Math.min(content.length, start + MAX_SNIPPET_BYTES);
        const prefix = start > 0 ? `…[${start} chars omitted]\n` : "";
        return prefix + content.slice(start, end);
      }
    }
  }

  // Fall back to first N bytes
  return content.slice(0, MAX_SNIPPET_BYTES) + `\n…[truncated]`;
}

// ---------------------------------------------------------------------------
// Build LLM verification context for a claim
// ---------------------------------------------------------------------------

export interface VerificationContext {
  /** Cleaned claim text (prefix stripped) */
  claim: string;
  /** Code snippets keyed by short file label */
  snippets: Record<string, string>;
  /** True if no code was found at all */
  isNoCode: boolean;
}

/**
 * Prepare context for LLM verification of a classified claim.
 * Extracts keywords from grep-verifier and reads relevant file snippets.
 */
export function buildVerificationContext(
  classified: ClassifiedClaim,
  maxFiles = 3,
): VerificationContext {
  const claim = stripConfidencePrefix(classified.content);
  const filesToRead = classified.grep.matchedFiles.slice(0, maxFiles);

  const terms = extractKeywords(claim);

  const snippets: Record<string, string> = {};
  for (const file of filesToRead) {
    const label = file.split("/").slice(-2).join("/");
    const snippet = readCodeSnippet(file, terms);
    if (snippet) snippets[label] = snippet;
  }

  return {
    claim,
    snippets,
    isNoCode: classified.grep.bucket === "no_code",
  };
}
