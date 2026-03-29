import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, copyFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, extname, basename, dirname } from "path";
import { sessionsDb } from "../sqlite/db.js";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConflictType = "missing" | "version_drift" | "orphaned_override";

export interface SkillEntry {
  skill_name: string;
  scope: "global" | "repo";
  file_hash: string;
  source_path: string;
}

export interface SkillConflict {
  type: ConflictType;
  skill_name: string;
  global_hash?: string;
  repo_hash?: string;
  detail: string;
}

export interface SkillIndexResult {
  repo: string;
  global_skills: number;
  repo_skills: number;
  conflicts: SkillConflict[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SKILL_EXTENSIONS = new Set([".md", ".txt", ".yaml", ".yml"]);

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function walkSkillDir(dir: string): SkillEntry[] {
  if (!existsSync(dir)) return [];
  const entries: SkillEntry[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  for (const file of files) {
    if (!SKILL_EXTENSIONS.has(extname(file))) continue;
    const fullPath = join(dir, file);
    try {
      const content = readFileSync(fullPath, "utf8");
      entries.push({
        skill_name: basename(file, extname(file)),
        scope: "global", // caller overrides this
        file_hash: sha256(content),
        source_path: fullPath,
      });
    } catch {
      // unreadable — skip
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function indexSkills(
  repo: string,
  cwd: string,
): Promise<SkillIndexResult> {
  const home = homedir();

  // Global dirs: ~/.claude/skills/ and ~/.cursor/rules/
  const globalDirs = [
    join(home, ".claude", "skills"),
    join(home, ".cursor", "rules"),
  ];
  // Repo dirs: {cwd}/.claude/skills/ and {cwd}/.cursor/rules/
  const repoDirs = [
    join(cwd, ".claude", "skills"),
    join(cwd, ".cursor", "rules"),
  ];

  const globalEntries = globalDirs
    .flatMap(walkSkillDir)
    .map((e): SkillEntry => ({ ...e, scope: "global" }));

  const repoEntries = repoDirs
    .flatMap(walkSkillDir)
    .map((e): SkillEntry => ({ ...e, scope: "repo" }));

  // Clear existing index for this repo + global (full re-index)
  await sessionsDb.execute({
    sql: `DELETE FROM skill_manifest WHERE repo IN (?, 'global')`,
    args: [repo],
  });

  const now = Date.now();

  for (const entry of globalEntries) {
    await sessionsDb.execute({
      sql: `INSERT OR REPLACE INTO skill_manifest
              (id, repo, skill_name, file_hash, scope, updated_at, created_at)
            VALUES (?, 'global', ?, ?, 'global', ?, ?)`,
      args: [randomUUID(), entry.skill_name, entry.file_hash, now, now],
    });
  }

  for (const entry of repoEntries) {
    await sessionsDb.execute({
      sql: `INSERT OR REPLACE INTO skill_manifest
              (id, repo, skill_name, file_hash, scope, updated_at, created_at)
            VALUES (?, ?, ?, ?, 'repo', ?, ?)`,
      args: [randomUUID(), repo, entry.skill_name, entry.file_hash, now, now],
    });
  }

  const conflicts = detectConflicts(globalEntries, repoEntries);

  return {
    repo,
    global_skills: globalEntries.length,
    repo_skills: repoEntries.length,
    conflicts,
  };
}

function detectConflicts(
  globals: SkillEntry[],
  repoSkills: SkillEntry[],
): SkillConflict[] {
  const globalMap = new Map<string, SkillEntry>(globals.map((e) => [e.skill_name, e]));
  const repoMap = new Map<string, SkillEntry>(repoSkills.map((e) => [e.skill_name, e]));
  const conflicts: SkillConflict[] = [];

  // version_drift: same name in both, different hash
  for (const [name, repoEntry] of repoMap) {
    const globalEntry = globalMap.get(name);
    if (globalEntry) {
      if (globalEntry.file_hash !== repoEntry.file_hash) {
        conflicts.push({
          type: "version_drift",
          skill_name: name,
          global_hash: globalEntry.file_hash.slice(0, 12),
          repo_hash: repoEntry.file_hash.slice(0, 12),
          detail: `Repo override of '${name}' differs from global version`,
        });
      }
    } else {
      // orphaned_override: repo skill with no global counterpart
      conflicts.push({
        type: "orphaned_override",
        skill_name: name,
        repo_hash: repoEntry.file_hash.slice(0, 12),
        detail: `Repo-level skill '${name}' has no matching global skill`,
      });
    }
  }

  // missing: global skill absent from repo (only flag if repo has any overrides at all)
  if (repoMap.size > 0) {
    for (const [name, globalEntry] of globalMap) {
      if (!repoMap.has(name)) {
        conflicts.push({
          type: "missing",
          skill_name: name,
          global_hash: globalEntry.file_hash.slice(0, 12),
          detail: `Global skill '${name}' is not overridden in this repo`,
        });
      }
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Onboarding report
// ---------------------------------------------------------------------------

export interface SkillItem {
  skill_name: string;
  file_hash: string;
  source_path?: string;
  detail?: string;
}

export interface SkillsOnboardingReport {
  canonical_skills: SkillItem[];
  you_have: SkillItem[];
  you_are_missing: SkillItem[];
  you_have_extra: SkillItem[];
  install_commands: string[];
}

export async function getOnboardingReport(
  _repo: string,
  cwd: string,
): Promise<SkillsOnboardingReport> {
  const home = homedir();

  // Canonical = what the repo defines as team standard (repo-level skill dirs)
  const canonicalDirs = [
    join(cwd, ".claude", "skills"),
    join(cwd, ".cursor", "rules"),
  ];
  const globalDirs = [
    join(home, ".claude", "skills"),
    join(home, ".cursor", "rules"),
  ];

  const canonicalEntries = canonicalDirs.flatMap(walkSkillDir);
  const globalEntries = globalDirs.flatMap(walkSkillDir);

  const globalMap = new Map<string, SkillEntry>(globalEntries.map((e) => [e.skill_name, e]));

  const youHave: SkillItem[] = [];
  const youAreMissing: SkillItem[] = [];

  for (const canonical of canonicalEntries) {
    const globalEntry = globalMap.get(canonical.skill_name);
    if (globalEntry && globalEntry.file_hash === canonical.file_hash) {
      youHave.push({ skill_name: canonical.skill_name, file_hash: canonical.file_hash });
    } else if (globalEntry) {
      // Exists globally but different version
      youAreMissing.push({
        skill_name: canonical.skill_name,
        file_hash: canonical.file_hash,
        source_path: canonical.source_path,
        detail: "version mismatch — global version differs from team canonical",
      });
    } else {
      youAreMissing.push({
        skill_name: canonical.skill_name,
        file_hash: canonical.file_hash,
        source_path: canonical.source_path,
        detail: "not installed globally",
      });
    }
  }

  const canonicalNames = new Set(canonicalEntries.map((e) => e.skill_name));
  const youHaveExtra: SkillItem[] = globalEntries
    .filter((e) => !canonicalNames.has(e.skill_name))
    .map((e) => ({ skill_name: e.skill_name, file_hash: e.file_hash }));

  const installCommands = youAreMissing.map(
    (s) => `claude-lore skills install ${s.skill_name}`,
  );

  return {
    canonical_skills: canonicalEntries.map((e) => ({
      skill_name: e.skill_name,
      file_hash: e.file_hash,
      source_path: e.source_path,
    })),
    you_have: youHave,
    you_are_missing: youAreMissing,
    you_have_extra: youHaveExtra,
    install_commands: installCommands,
  };
}

export async function installSkill(
  skillName: string,
  _repo: string,
  cwd: string,
): Promise<{ ok: boolean; dest?: string; error?: string }> {
  const home = homedir();

  // Find the canonical skill file in repo dirs
  const canonicalDirs = [
    { dir: join(cwd, ".claude", "skills"), globalDir: join(home, ".claude", "skills") },
    { dir: join(cwd, ".cursor", "rules"), globalDir: join(home, ".cursor", "rules") },
  ];

  for (const { dir, globalDir } of canonicalDirs) {
    if (!existsSync(dir)) continue;
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (!SKILL_EXTENSIONS.has(extname(file))) continue;
      if (basename(file, extname(file)) !== skillName) continue;
      const src = join(dir, file);
      const dest = join(globalDir, file);
      try {
        mkdirSync(globalDir, { recursive: true });
        copyFileSync(src, dest);
        return { ok: true, dest };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
  }
  return { ok: false, error: `Skill '${skillName}' not found in repo canonical dirs` };
}

export async function getSkillConflicts(repo: string): Promise<SkillConflict[]> {
  const globalRes = await sessionsDb.execute({
    sql: `SELECT skill_name, file_hash FROM skill_manifest WHERE repo = 'global' AND scope = 'global'`,
    args: [],
  });
  const repoRes = await sessionsDb.execute({
    sql: `SELECT skill_name, file_hash FROM skill_manifest WHERE repo = ? AND scope = 'repo'`,
    args: [repo],
  });

  const globalEntries: SkillEntry[] = globalRes.rows.map((r) => ({
    skill_name: String(r["skill_name"]),
    scope: "global" as const,
    file_hash: String(r["file_hash"]),
    source_path: "",
  }));
  const repoEntries: SkillEntry[] = repoRes.rows.map((r) => ({
    skill_name: String(r["skill_name"]),
    scope: "repo" as const,
    file_hash: String(r["file_hash"]),
    source_path: "",
  }));

  return detectConflicts(globalEntries, repoEntries);
}
