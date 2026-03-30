import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join, isAbsolute, resolve } from "path";
import type { LoreTemplate } from "./types.js";

// Built-in templates — resolved relative to this file
import sampleTemplate from "./templates/sample/index.js";
import owaspTemplate from "./templates/owasp-top10/index.js";
import monorepoServicesTemplate from "./templates/monorepo-services/index.js";
import cursorRulesTemplate from "./templates/cursor-rules/index.js";
import securityChecklistTemplate from "./templates/security-checklist/index.js";

const BUILT_INS: LoreTemplate[] = [
  sampleTemplate,
  owaspTemplate,
  monorepoServicesTemplate,
  cursorRulesTemplate,
  securityChecklistTemplate,
];

const MAX_TEMPLATE_DIRS = 100;

/** Load templates from a directory, each template in its own subdirectory with index.js */
async function loadFromDir(dir: string): Promise<LoreTemplate[]> {
  if (!existsSync(dir)) return [];

  const results: LoreTemplate[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  if (entries.length > MAX_TEMPLATE_DIRS) {
    console.warn(`[bootstrap] template directory ${dir} has ${entries.length} entries, scanning first ${MAX_TEMPLATE_DIRS} only`);
    entries = entries.slice(0, MAX_TEMPLATE_DIRS);
  }

  for (const entry of entries) {
    const indexPath = join(dir, entry, "index.js");
    if (!existsSync(indexPath)) continue;
    try {
      const mod = await import(indexPath);
      const tmpl: unknown = mod.default ?? mod;
      if (isTemplate(tmpl)) results.push(tmpl);
    } catch {
      // Skip malformed external templates
    }
  }
  return results;
}

function isTemplate(x: unknown): x is LoreTemplate {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as LoreTemplate).id === "string" &&
    typeof (x as LoreTemplate).generate === "function"
  );
}

/**
 * Build the full template registry.
 * Resolution order: built-ins → user (~/.codegraph/templates/) → repo-local ({repo}/.codegraph/templates/)
 * Later registrations override earlier ones on `id` collision.
 */
export async function buildRegistry(repo: string): Promise<Map<string, LoreTemplate>> {
  const userDir = join(homedir(), ".codegraph", "templates");
  // Only load repo-local templates when repo is an absolute, non-traversal path
  const safeRepo = isAbsolute(repo) && resolve(repo) === repo ? repo : null;
  const repoDir = safeRepo ? join(safeRepo, ".codegraph", "templates") : null;

  const [userTemplates, repoTemplates] = await Promise.all([
    loadFromDir(userDir),
    repoDir ? loadFromDir(repoDir) : Promise.resolve([]),
  ]);

  const registry = new Map<string, LoreTemplate>();
  for (const t of [...BUILT_INS, ...userTemplates, ...repoTemplates]) {
    registry.set(t.id, t);
  }
  return registry;
}

export async function listTemplates(repo: string, includeHidden = false): Promise<LoreTemplate[]> {
  const registry = await buildRegistry(repo);
  const all = Array.from(registry.values());
  return includeHidden ? all : all.filter((t) => !t.hidden);
}

/** Validate that a path is safe to use as a repo root (absolute, no traversal). */
export function isSafeRepoPath(p: string): boolean {
  return isAbsolute(p) && resolve(p) === p;
}
