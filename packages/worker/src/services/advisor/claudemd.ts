import { existsSync, readFileSync } from "fs";
import { join, isAbsolute, resolve } from "path";
import { sessionsDb } from "../sqlite/db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FindingType = "redundant" | "missing" | "outdated" | "optimise";

export interface ClaudeMdFinding {
  type: FindingType;
  description: string;
  line?: number;
  suggestion?: string;
}

export interface ClaudeMdAnalysis {
  repo: string;
  generated_at: number;
  claude_md_present: boolean;
  token_estimate: number;
  findings: ClaudeMdFinding[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rough token estimate: ~4 chars per token */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const KNOWN_TECH_PATTERNS: Array<[RegExp, string]> = [
  [/\bexpress\b/i, "express"],
  [/\bfastify\b/i, "fastify"],
  [/\bhono\b/i, "hono"],
  [/\bnext\.?js\b/i, "nextjs"],
  [/\bnuxt\b/i, "nuxt"],
  [/\breact\b/i, "react"],
  [/\bvite\b/i, "vite"],
  [/\bprisma\b/i, "prisma"],
  [/\bdrizzle\b/i, "drizzle"],
  [/\bpg\b|\bpostgres/i, "postgres"],
  [/\bmysql\b/i, "mysql"],
  [/\bmongo\b/i, "mongo"],
  [/\bredis\b/i, "redis"],
  [/\bjest\b/i, "jest"],
  [/\bvitest\b/i, "vitest"],
];

async function detectedTech(repo: string, cwd: string): Promise<Set<string>> {
  const detected = new Set<string>();

  // Check package.json deps
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
      const allDeps = {
        ...(pkg["dependencies"] as Record<string, string> | undefined),
        ...(pkg["devDependencies"] as Record<string, string> | undefined),
      };
      for (const [pattern, tech] of KNOWN_TECH_PATTERNS) {
        if (Object.keys(allDeps).some((d) => pattern.test(d))) {
          detected.add(tech);
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  // Check decisions for technology mentions
  try {
    const res = await sessionsDb.execute({
      sql: `SELECT content FROM decisions WHERE repo = ? AND confidence = 'confirmed' LIMIT 50`,
      args: [repo],
    });
    for (const row of res.rows) {
      const content = String((row as Record<string, unknown>)["content"] ?? "");
      for (const [pattern, tech] of KNOWN_TECH_PATTERNS) {
        if (pattern.test(content)) detected.add(tech);
      }
    }
  } catch {
    // ignore
  }

  return detected;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export async function analyseClaudeMd(
  repo: string,
  cwd: string,
): Promise<ClaudeMdAnalysis> {
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) {
    throw new Error("cwd must be an absolute, non-traversal path");
  }

  const now = Date.now();
  const findings: ClaudeMdFinding[] = [];

  const claudeMdPath = join(cwd, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    return {
      repo,
      generated_at: now,
      claude_md_present: false,
      token_estimate: 0,
      findings: [
        {
          type: "missing",
          description: "No CLAUDE.md found. Claude Code has no persistent instructions for this repo.",
          suggestion: "Run `claude` in the repo and ask it to create a CLAUDE.md with project conventions.",
        },
      ],
    };
  }

  const content = readFileSync(claudeMdPath, "utf8");
  const lines = content.split("\n");
  const tokenEstimate = estimateTokens(content);

  // Check 1: token budget (>4000 tokens = bloated)
  if (tokenEstimate > 4000) {
    findings.push({
      type: "optimise",
      description: `CLAUDE.md is large (~${tokenEstimate} tokens). This consumes a significant portion of the context window on every session.`,
      suggestion: "Move stable reference material (e.g. API docs, full schema) to a separate file and link to it.",
    });
  }

  // Check 2: duplicate sections
  const seenHeadings = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      const normalised = headingMatch[1]!.toLowerCase().trim();
      if (seenHeadings.has(normalised)) {
        findings.push({
          type: "redundant",
          description: `Duplicate section heading "${headingMatch[1]}" at line ${i + 1} (first at line ${seenHeadings.get(normalised)! + 1}).`,
          line: i + 1,
          suggestion: "Merge the duplicate sections.",
        });
      } else {
        seenHeadings.set(normalised, i);
      }
    }
  }

  // Check 3: repeated identical lines (copy-paste)
  const lineCounts = new Map<string, number[]>();
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.length < 20) continue; // skip short/empty lines
    const existing = lineCounts.get(trimmed) ?? [];
    existing.push(i + 1);
    lineCounts.set(trimmed, existing);
  }
  for (const [text, occurrences] of lineCounts) {
    if (occurrences.length >= 2) {
      findings.push({
        type: "redundant",
        description: `Line appears ${occurrences.length}x: "${text.slice(0, 60)}..." (lines ${occurrences.join(", ")}).`,
        line: occurrences[0],
        suggestion: "Remove duplicate lines.",
      });
    }
  }

  // Check 4: outdated technology references
  const tech = await detectedTech(repo, cwd);
  const deprecatedPatterns: Array<[RegExp, string, string]> = [
    [/\bnpm run\b/i, "npm run", "Consider `bun run` if this project uses Bun (detected in package.json)."],
    [/node_modules/i, "node_modules reference", "Prefer package manager commands over direct node_modules references."],
    [/\.env\.local/i, ".env.local", "Confirm .env.local is still used — many projects have moved to .env or secret managers."],
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const [pattern, label, suggestion] of deprecatedPatterns) {
      if (pattern.test(line)) {
        findings.push({
          type: "outdated",
          description: `Line ${i + 1} references ${label}: "${line.trim().slice(0, 80)}"`,
          line: i + 1,
          suggestion,
        });
        break; // one finding per line
      }
    }
  }

  // Check 5: missing sections that are commonly useful
  const contentLower = content.toLowerCase();
  const missingSections: Array<[string, string]> = [
    ["test", "No testing instructions found. Add a section explaining how to run tests for this repo."],
    ["build", "No build instructions found. Add a section explaining how to build the project."],
  ];

  // Only flag as missing if the file has content but lacks these sections
  if (tokenEstimate > 200) {
    for (const [keyword, suggestion] of missingSections) {
      if (!contentLower.includes(keyword)) {
        findings.push({
          type: "missing",
          description: `No "${keyword}" section or keyword found in CLAUDE.md.`,
          suggestion,
        });
      }
    }
  }

  // Check 6: tech detected in repo but not mentioned in CLAUDE.md
  for (const t of tech) {
    if (!contentLower.includes(t)) {
      findings.push({
        type: "missing",
        description: `Technology "${t}" detected in package.json but not mentioned in CLAUDE.md.`,
        suggestion: `Add a note about ${t} conventions to CLAUDE.md so agents know how it is used.`,
      });
    }
  }

  // Check 7: stale confirmed decisions not referenced in CLAUDE.md
  try {
    const decisionsRes = await sessionsDb.execute({
      sql: `SELECT content FROM decisions
            WHERE repo = ? AND confidence = 'confirmed'
            ORDER BY created_at DESC LIMIT 20`,
      args: [repo],
    });
    for (const row of decisionsRes.rows) {
      const decision = String((row as Record<string, unknown>)["content"] ?? "");
      // Extract the first significant keyword from the decision
      const firstWord = decision
        .replace(/[^a-zA-Z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 4)
        .slice(0, 3)
        .join(" ")
        .toLowerCase();
      if (firstWord && !contentLower.includes(firstWord)) {
        findings.push({
          type: "outdated",
          description: `Confirmed decision not reflected in CLAUDE.md: "${decision.slice(0, 100)}..."`,
          suggestion: "Add this confirmed decision to CLAUDE.md so future sessions start with this context.",
        });
        break; // one finding of this type is enough
      }
    }
  } catch {
    // ignore
  }

  return {
    repo,
    generated_at: now,
    claude_md_present: true,
    token_estimate: tokenEstimate,
    findings,
  };
}
