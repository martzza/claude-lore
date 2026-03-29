const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function assertWorkerRunning(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error();
  } catch {
    console.error("Worker not running. Start it with: claude-lore worker start");
    process.exit(1);
  }
}

export async function runSkills(opts: { diff?: boolean; onboarding?: boolean }): Promise<void> {
  const repo = process.cwd();
  await assertWorkerRunning();

  if (opts.onboarding) {
    const res = await fetch(
      `${BASE_URL}/api/skills/onboarding?repo=${encodeURIComponent(repo)}&cwd=${encodeURIComponent(repo)}`,
    );
    const data = (await res.json()) as {
      canonical_skills: Array<{ skill_name: string }>;
      you_have: Array<{ skill_name: string }>;
      you_are_missing: Array<{ skill_name: string; detail?: string }>;
      you_have_extra: Array<{ skill_name: string }>;
      install_commands: string[];
    };

    const total = data.canonical_skills.length;
    console.log(`\nSkills check — joining the team`);
    console.log("────────────────────────────────");
    console.log(
      `This repo uses ${total} canonical skill${total !== 1 ? "s" : ""}. Here's how you compare:\n`,
    );

    for (const s of data.you_have) {
      console.log(`  ✓  ${s.skill_name.padEnd(20)} installed and up to date`);
    }
    for (const s of data.you_are_missing) {
      const detail = s.detail ?? "MISSING";
      console.log(`  ✗  ${s.skill_name.padEnd(20)} ${detail.toUpperCase()} — this team uses this skill`);
    }

    if (data.you_are_missing.length > 0) {
      console.log("\nTo install missing skills:");
      for (const cmd of data.install_commands) {
        console.log(`  ${cmd}`);
      }
      console.log("\nOr install all at once:");
      console.log("  claude-lore skills install --all-missing");
    }

    if (data.you_have_extra.length > 0) {
      console.log(`\nYou have ${data.you_have_extra.length} local skill${data.you_have_extra.length !== 1 ? "s" : ""} not used by the team:`);
      for (const s of data.you_have_extra) {
        console.log(`  ${s.skill_name.padEnd(20)} (local only — not a problem)`);
      }
    }

    console.log("\nRun this check again: claude-lore skills --onboarding\n");
    return;
  }

  if (opts.diff) {
    const res = await fetch(`${BASE_URL}/api/skills/conflicts?repo=${encodeURIComponent(repo)}`);
    const data = (await res.json()) as {
      conflicts: {
        missing: unknown[];
        version_drift: Array<{ skill_name: string; global_hash?: string; repo_hash?: string }>;
        orphaned_override: Array<{ skill_name: string; repo_hash?: string }>;
      };
      total: number;
    };

    if (data.total === 0) {
      console.log("No skill conflicts detected.");
      return;
    }

    if (data.conflicts.version_drift.length > 0) {
      console.log("\n[version_drift]");
      for (const c of data.conflicts.version_drift) {
        console.log(`  ${c.skill_name}  global=${c.global_hash}  repo=${c.repo_hash}`);
      }
    }
    if (data.conflicts.orphaned_override.length > 0) {
      console.log("\n[orphaned_override]");
      for (const c of data.conflicts.orphaned_override) {
        console.log(`  ${c.skill_name}  (${c.repo_hash})`);
      }
    }
    if (data.conflicts.missing.length > 0) {
      console.log(`\n[missing]  ${data.conflicts.missing.length} global skill(s) not in repo`);
    }
    return;
  }

  // Default: index and display counts
  const res = await fetch(`${BASE_URL}/api/skills/index`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, cwd: repo }),
  });
  const data = (await res.json()) as {
    global_skills: number;
    repo_skills: number;
    conflicts: unknown[];
  };
  console.log(`Global skills:  ${data.global_skills}`);
  console.log(`Repo skills:    ${data.repo_skills}`);
  console.log(`Conflicts:      ${data.conflicts.length}`);
  if (data.conflicts.length > 0) {
    console.log('\nRun `claude-lore skills --diff` to see details.');
  }
}

export async function runSkillsInstall(
  skillName: string | undefined,
  opts: { allMissing?: boolean },
): Promise<void> {
  const repo = process.cwd();
  await assertWorkerRunning();

  if (opts.allMissing) {
    // Fetch onboarding report then install all missing
    const reportRes = await fetch(
      `${BASE_URL}/api/skills/onboarding?repo=${encodeURIComponent(repo)}&cwd=${encodeURIComponent(repo)}`,
    );
    const report = (await reportRes.json()) as {
      you_are_missing: Array<{ skill_name: string }>;
    };

    if (report.you_are_missing.length === 0) {
      console.log("All canonical skills are already installed.");
      return;
    }

    for (const s of report.you_are_missing) {
      await installOne(s.skill_name, repo);
    }
    return;
  }

  if (!skillName) {
    console.error("Provide a skill name or use --all-missing");
    process.exit(1);
  }

  await installOne(skillName, repo);
}

// ---------------------------------------------------------------------------
// skills suggest
// ---------------------------------------------------------------------------

const CLAUDE_LORE_SKILLS = [
  { name: "kg-query",  trigger: "/lore",   desc: "Query the knowledge graph — decisions, risks, deferred, session history" },
  { name: "kg-doc",    trigger: "/doc",    desc: "Generate runbooks, architecture docs, ADRs, and onboarding guides" },
  { name: "review",    trigger: "/review", desc: "Visual codebase map, pre-commit diff overlay, propagation view" },
];

// Skills from the Claude Code ecosystem that pair well with claude-lore.
// Listed in priority order — most commonly useful first.
const PAIRED_SKILLS = [
  {
    category: "Git workflow",
    skills: [
      { name: "commit",           source: "claude-code built-in", desc: "Generate conventional commit messages from staged changes" },
      { name: "review-pr",        source: "claude-code built-in", desc: "AI-powered pull request review with inline comments" },
    ],
  },
  {
    category: "Code quality",
    skills: [
      { name: "simplify",         source: "claude-code built-in", desc: "Review changed code for reuse, quality, and efficiency" },
      { name: "claude-api",       source: "claude-code built-in", desc: "Build apps with the Claude API / Anthropic SDK" },
    ],
  },
  {
    category: "Automation",
    skills: [
      { name: "loop",             source: "claude-code built-in", desc: "Run a skill on a recurring interval (polling, babysitting)" },
      { name: "schedule",         source: "claude-code built-in", desc: "Schedule agents to run on a cron expression" },
      { name: "update-config",    source: "claude-code built-in", desc: "Configure hooks, permissions, and env vars in settings.json" },
    ],
  },
  {
    category: "Community (high-star marketplace examples)",
    skills: [
      { name: "test-gen",         source: "marketplace",          desc: "Generate test cases for a selected file or function" },
      { name: "explain",          source: "marketplace",          desc: "Explain a function, module, or error in plain language" },
      { name: "refactor",         source: "marketplace",          desc: "Guided refactoring with blast-radius awareness" },
      { name: "changelog",        source: "marketplace",          desc: "Generate CHANGELOG entries from commit history" },
    ],
  },
];

export function runSkillsSuggest(): void {
  console.log("\nSkills installed by claude-lore");
  console.log("────────────────────────────────");
  for (const s of CLAUDE_LORE_SKILLS) {
    console.log(`  ${s.trigger.padEnd(10)}  ${s.name.padEnd(12)}  ${s.desc}`);
  }

  console.log("\nSkills that pair well with claude-lore");
  console.log("───────────────────────────────────────");
  for (const group of PAIRED_SKILLS) {
    console.log(`\n  ${group.category}`);
    for (const s of group.skills) {
      const src = `[${s.source}]`;
      console.log(`    ${s.name.padEnd(18)} ${src.padEnd(26)} ${s.desc}`);
    }
  }

  console.log("\nHow to install");
  console.log("───────────────");
  console.log("  Claude Code built-ins are available automatically.");
  console.log("  Invoke them with /commit, /review-pr, /simplify, etc.\n");
  console.log("  To install a marketplace skill:");
  console.log("    1. Search at https://claude.ai/code/marketplace");
  console.log("    2. Copy the .md skill file into .claude/skills/ in your repo");
  console.log("       (repo-scoped) or ~/.claude/skills/ (global)\n");
  console.log("  To see team skill alignment:");
  console.log("    claude-lore skills --onboarding\n");
  console.log("  To install a canonical team skill:");
  console.log("    claude-lore skills install <name>\n");
}

async function installOne(skillName: string, repo: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/skills/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, cwd: repo, skill_name: skillName }),
  });
  const data = (await res.json()) as { ok: boolean; dest?: string; error?: string };
  if (data.ok) {
    console.log(`  ✓  ${skillName} installed → ${data.dest}`);
  } else {
    console.log(`  ✗  ${skillName}: ${data.error}`);
  }
}
