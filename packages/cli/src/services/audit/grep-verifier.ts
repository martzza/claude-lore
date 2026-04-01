import { execSync } from "child_process";
import { join, extname } from "path";
import type { GrepResult } from "./types.js";

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "on", "at", "by", "for", "with", "about",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "from", "up", "down", "out", "off", "over", "under", "again", "further",
  "then", "once", "and", "or", "but", "if", "so", "yet", "both", "either",
  "this", "that", "these", "those", "it", "its", "all", "any", "each",
  "every", "both", "more", "most", "other", "some", "such", "no", "not",
  "only", "own", "same", "than", "too", "very", "just", "via", "when",
  "where", "which", "who", "whom", "how", "what", "why", "always", "never",
  "must", "should", "using", "uses", "use", "used", "always", "never",
]);

/**
 * Extract up to `maxTerms` search terms from claim content.
 * Prefers camelCase, snake_case, and PascalCase identifiers over plain words.
 */
export function extractKeywords(content: string, maxTerms = 4): string[] {
  // Extract identifier-like tokens first (camelCase, snake_case, PascalCase, dotted)
  const identifiers = Array.from(content.matchAll(/\b([a-zA-Z][a-zA-Z0-9_]{2,}(?:[._][a-zA-Z][a-zA-Z0-9_]+)*)\b/g))
    .map((m) => m[1]!)
    .filter((t) => {
      const lower = t.toLowerCase();
      if (STOP_WORDS.has(lower)) return false;
      // prefer tokens that look like code identifiers
      if (/[A-Z]/.test(t[1] ?? "")) return true;  // PascalCase / camelCase
      if (/_/.test(t)) return true;                 // snake_case
      return t.length >= 5;                          // long plain words
    });

  // De-duplicate preserving order
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const id of identifiers) {
    if (!seen.has(id) && terms.length < maxTerms) {
      seen.add(id);
      terms.push(id);
    }
  }

  // Fall back to any non-stopword >= 4 chars if we have too few
  if (terms.length < 2) {
    for (const word of content.split(/\W+/)) {
      if (word.length >= 4 && !STOP_WORDS.has(word.toLowerCase()) && !seen.has(word)) {
        seen.add(word);
        terms.push(word);
        if (terms.length >= maxTerms) break;
      }
    }
  }

  return terms;
}

// ---------------------------------------------------------------------------
// Grep runner
// ---------------------------------------------------------------------------

const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".rb", ".cs", ".cpp", ".c", ".h",
]);

const SKIP_DIRS = [
  "node_modules", ".git", "dist", "build", "coverage",
  ".codegraph", ".next", ".turbo", "out", ".cache",
];

function buildRgArgs(repoPath: string, terms: string[]): string {
  if (terms.length === 0) return "";
  const skipArgs = SKIP_DIRS.map((d) => `--glob '!${d}/**'`).join(" ");

  // Search for ANY of the terms (-e for each)
  const termArgs = terms.map((t) => `-e '${t.replace(/'/g, "'\\''")}'`).join(" ");

  // Restrict to code extensions
  const extArgs = Array.from(CODE_EXTS).map((e) => `--glob '*${e}'`).join(" ");

  return `rg --no-messages -l ${skipArgs} ${extArgs} ${termArgs} '${repoPath}'`;
}

function buildGrepFallback(repoPath: string, terms: string[]): string {
  if (terms.length === 0) return "";
  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const skipArgs = SKIP_DIRS.map((d) => `--exclude-dir=${d}`).join(" ");
  const extArgs = Array.from(CODE_EXTS).map((e) => `--include='*${e}'`).join(" ");
  return `grep -rl ${skipArgs} ${extArgs} -E '${pattern}' '${repoPath}'`;
}

/**
 * Run grep/rg for the given terms against code files in repoPath.
 * Returns a list of matched file paths.
 */
export function grepForTerms(repoPath: string, terms: string[]): string[] {
  if (terms.length === 0) return [];

  // Try ripgrep first, fall back to grep
  const commands = [buildRgArgs(repoPath, terms), buildGrepFallback(repoPath, terms)];
  for (const cmd of commands) {
    if (!cmd) continue;
    try {
      const output = execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      if (!output) return [];
      return output.split("\n").filter(Boolean);
    } catch (err: unknown) {
      // rg/grep exits 1 when no matches — that's OK
      if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 1) {
        return [];
      }
      // Try next command
      continue;
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Bucket classification
// ---------------------------------------------------------------------------

/**
 * Classify grep results into verification buckets.
 *
 * verified   — ≥2 distinct files matched (strong signal)
 * ambiguous  — exactly 1 file matched (weak signal, may need LLM)
 * no_code    — 0 files matched (claim may be a gap)
 */
function classifyBucket(matchedFiles: string[]): GrepResult["bucket"] {
  if (matchedFiles.length >= 2) return "verified";
  if (matchedFiles.length === 1) return "ambiguous";
  return "no_code";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface VerifyOptions {
  repoPath: string;
  maxTerms?: number;
}

export function verifyClaim(content: string, opts: VerifyOptions): GrepResult {
  const terms = extractKeywords(content, opts.maxTerms ?? 4);
  const matchedFiles = grepForTerms(opts.repoPath, terms);
  return {
    matchCount: matchedFiles.length,
    matchedFiles,
    bucket: classifyBucket(matchedFiles),
  };
}
