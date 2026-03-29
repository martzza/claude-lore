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

export async function runSkills(opts: { diff?: boolean }): Promise<void> {
  const repo = process.cwd();
  await assertWorkerRunning();

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

  // Index and display
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
