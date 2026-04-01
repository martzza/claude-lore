import { execSync } from "child_process";
import { join } from "path";

export interface GitAttribution {
  author: string;
  date: string;
  message: string;
  /** Short commit SHA */
  sha: string;
}

/**
 * Return the most recent git commit that touched `filePath`.
 * Returns null if git is unavailable or the file has no history.
 */
export function getLastTouch(filePath: string): GitAttribution | null {
  try {
    // %an = author name, %as = author date (YYYY-MM-DD), %s = subject, %h = short SHA
    const output = execSync(
      `git log --follow --diff-filter=M --format="%an%x00%as%x00%s%x00%h" -1 -- '${filePath.replace(/'/g, "'\\''")}'`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();

    if (!output) return null;

    const parts = output.split("\x00");
    if (parts.length < 4) return null;

    return {
      author:  parts[0]!.trim(),
      date:    parts[1]!.trim(),
      message: parts[2]!.trim(),
      sha:     parts[3]!.trim(),
    };
  } catch {
    return null;
  }
}

/**
 * For a list of matched file paths, find the most recently touched file
 * and return its git attribution.
 */
export function getAttributionForFiles(files: string[]): GitAttribution | null {
  if (files.length === 0) return null;

  // Try the first few files and pick the most recent
  const candidates = files.slice(0, 5);
  const attributions: Array<GitAttribution & { ts: number }> = [];

  for (const file of candidates) {
    const attr = getLastTouch(file);
    if (attr && attr.date) {
      attributions.push({ ...attr, ts: Date.parse(attr.date) || 0 });
    }
  }

  if (attributions.length === 0) return null;

  // Most recent
  attributions.sort((a, b) => b.ts - a.ts);
  const { ts: _, ...result } = attributions[0]!;
  return result;
}

/**
 * Get the repo's first commit date — used to gauge repo age.
 */
export function getRepoFirstCommitDate(repoPath: string): string | null {
  try {
    const output = execSync(
      `git -C '${repoPath.replace(/'/g, "'\\''")}' log --reverse --format="%as" | head -1`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    return output || null;
  } catch {
    return null;
  }
}

/**
 * Count total commits in the repo — used as a maturity signal.
 */
export function getCommitCount(repoPath: string): number {
  try {
    const output = execSync(
      `git -C '${repoPath.replace(/'/g, "'\\''")}' rev-list --count HEAD`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    return parseInt(output, 10) || 0;
  } catch {
    return 0;
  }
}
