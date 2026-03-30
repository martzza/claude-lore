#!/usr/bin/env node
// Utility: detect the monorepo service name from a working directory.
//
// Algorithm (first match wins):
//   1. Find git root via `git rev-parse --show-toplevel`
//   2. If cwd IS the git root → return null (not inside a subpackage)
//   3. Read <cwd>/package.json → return `name` field if present
//   4. Fall back to the relative path from git root to cwd (e.g. "packages/api")
//   5. On any error → return null (graceful degradation, never throws)
//
// Usage:
//   import { detectService } from "./detect-service.js";
//   const service = detectService(process.cwd()); // string | null

import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join, relative } from "path";

/**
 * @param {string} cwd
 * @returns {string | null}
 */
export function detectService(cwd) {
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const rel = relative(gitRoot, cwd);

    // At repo root — no service context
    if (!rel || rel === ".") return null;

    // Try package.json name field
    const pkgPath = join(cwd, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (typeof pkg.name === "string" && pkg.name.length > 0) {
          return pkg.name;
        }
      } catch {}
    }

    // Fall back to relative path (e.g. "packages/api", "apps/web")
    return rel;
  } catch {
    return null;
  }
}
