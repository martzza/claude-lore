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
