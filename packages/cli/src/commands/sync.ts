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

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export async function runSyncStatus(): Promise<void> {
  await assertWorkerRunning();
  const res = await fetch(`${BASE_URL}/api/sync/status`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) { console.error("Failed to fetch sync status"); process.exit(1); }

  const data = (await res.json()) as {
    turso_connected: boolean;
    last_sync: { synced_at: number; status: string; duration_ms: number; sessions_changed: number; error: string | null } | null;
    unresolved_conflicts: number;
  };

  console.log("\nSync status");
  console.log("───────────");
  console.log(`  Turso:      ${data.turso_connected ? "connected" : "not configured"}`);

  if (data.last_sync) {
    const s = data.last_sync;
    const statusIcon = s.status === "success" ? "✓" : s.status === "skipped" ? "–" : "✗";
    console.log(`  Last sync:  ${statusIcon} ${s.status} · ${formatTimeAgo(s.synced_at)} · ${s.duration_ms}ms`);
    if (s.sessions_changed > 0) {
      console.log(`  Changes:    ${s.sessions_changed} row${s.sessions_changed !== 1 ? "s" : ""}`);
    }
    if (s.error) {
      console.log(`  Error:      ${s.error}`);
    }
  } else {
    console.log(`  Last sync:  never`);
  }

  if (data.unresolved_conflicts > 0) {
    console.log(`  Conflicts:  ${data.unresolved_conflicts} unresolved — run: claude-lore sync conflicts`);
  } else {
    console.log(`  Conflicts:  none`);
  }

  if (!data.turso_connected) {
    console.log("\n  To enable team sync, set:");
    console.log("    CLAUDE_LORE_TURSO_URL=libsql://...");
    console.log("    CLAUDE_LORE_TURSO_AUTH_TOKEN=...");
  }
}

export async function runSyncNow(): Promise<void> {
  await assertWorkerRunning();
  process.stdout.write("Syncing with Turso...\n");

  const res = await fetch(`${BASE_URL}/api/sync/now`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) { const e = await res.text(); console.error("Sync failed:", e); process.exit(1); }

  const data = (await res.json()) as {
    ok: boolean;
    entry: { status: string; duration_ms: number; sessions_changed: number; error: string | null };
  };

  const e = data.entry;
  if (e.status === "skipped") {
    console.log("Skipped — Turso not configured.");
    console.log("Set CLAUDE_LORE_TURSO_URL and CLAUDE_LORE_TURSO_AUTH_TOKEN to enable team sync.");
    return;
  }

  if (e.status === "success") {
    console.log(`✓ Sync complete (${e.duration_ms}ms)`);
    if (e.sessions_changed > 0) {
      console.log(`  ${e.sessions_changed} row${e.sessions_changed !== 1 ? "s" : ""} changed`);
    }
  } else {
    console.error(`✗ Sync failed: ${e.error ?? "unknown error"}`);
    process.exit(1);
  }
}

export async function runSyncConflicts(opts: { repo?: string; resolve?: string }): Promise<void> {
  await assertWorkerRunning();

  // Resolve a specific conflict by ID
  if (opts.resolve) {
    const res = await fetch(`${BASE_URL}/api/sync/conflicts/${encodeURIComponent(opts.resolve)}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: opts.resolve }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) { console.error("Failed to resolve conflict"); process.exit(1); }
    console.log(`Conflict ${opts.resolve} marked as resolved.`);
    return;
  }

  const params = new URLSearchParams();
  if (opts.repo) params.set("repo", opts.repo);
  const res = await fetch(`${BASE_URL}/api/sync/conflicts?${params}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) { console.error("Failed to fetch conflicts"); process.exit(1); }

  const data = (await res.json()) as {
    conflicts: Array<{
      id: string;
      detected_at: number;
      repo: string;
      table_name: string;
      record_id: string;
      conflict_type: string;
      local_content: string | null;
      remote_content: string | null;
      local_confirmed_by: string | null;
      remote_confirmed_by: string | null;
    }>;
  };

  if (data.conflicts.length === 0) {
    console.log("No unresolved sync conflicts.");
    return;
  }

  console.log(`\n${data.conflicts.length} unresolved conflict${data.conflicts.length !== 1 ? "s" : ""}\n`);

  for (const c of data.conflicts) {
    const repoName = c.repo.split("/").pop() ?? c.repo;
    console.log(`  [${c.conflict_type}] ${repoName} · ${c.table_name} · ${formatTimeAgo(c.detected_at)}`);
    console.log(`  ID: ${c.id}`);

    if (c.conflict_type === "overwritten") {
      console.log(`  Local:  ${(c.local_content ?? "").slice(0, 80)}`);
      console.log(`  Remote: ${(c.remote_content ?? "").slice(0, 80)}`);
      if (c.local_confirmed_by || c.remote_confirmed_by) {
        console.log(`  Authors: local=${c.local_confirmed_by ?? "?"} · remote=${c.remote_confirmed_by ?? "?"}`);
      }
    } else {
      console.log(`  Remote confirmation by: ${c.remote_confirmed_by ?? "unknown"}`);
      console.log(`  Content: ${(c.remote_content ?? "").slice(0, 80)}`);
    }

    console.log(`  Resolve: claude-lore sync conflicts --resolve ${c.id}\n`);
  }
}
