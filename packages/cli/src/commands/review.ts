import { createInterface } from "readline";

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

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

interface PendingRecord {
  id: string;
  table: string;
  type: string;
  repo: string;
  service: string | null;
  confidence: string;
  content: string;
  symbol: string | null;
  created_at: number;
  priority_score: number;
  group: "audit_queue" | "needs_review";
}

async function callLifecycle(id: string, table: string, action: string, note?: string): Promise<void> {
  await fetch(`${BASE_URL}/api/records/lifecycle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, table, action, note }),
  });
}

function actionsForType(type: string): string {
  if (type === "risk") {
    return "[c] confirm  [m] mitigated  [a] accepted  [e] edit  [d] discard  [v] still valid  [s] skip  [q] quit";
  }
  if (type === "deferred") {
    return "[c] confirm  [done] completed  [ab] abandoned  [e] edit  [d] discard  [v] still valid  [s] skip  [q] quit";
  }
  // decision
  return "[c] confirm  [e] edit  [d] discard  [v] still valid  [s] skip  [q] quit";
}

export async function runReview(opts: { service?: string } = {}): Promise<void> {
  await assertWorkerRunning();

  const repo = process.cwd();
  const params = new URLSearchParams({ repo });
  if (opts.service) params.set("service", opts.service);
  const res = await fetch(
    `${BASE_URL}/api/records/pending?${params}`,
    { signal: AbortSignal.timeout(5000) },
  );

  if (!res.ok) {
    console.error("Failed to fetch pending records");
    process.exit(1);
  }

  const body = (await res.json()) as { records: PendingRecord[] };
  const records = body.records;

  if (records.length === 0) {
    console.log("No pending records to review. Everything is confirmed or the graph is empty.");
    return;
  }

  const auditQueue = records.filter((r) => r.group === "audit_queue");
  const needsReview = records.filter((r) => r.group === "needs_review");

  console.log(`\n${records.length} record${records.length !== 1 ? "s" : ""} pending review`);
  if (auditQueue.length > 0) console.log(`  ${auditQueue.length} in audit queue (flagged for human review)`);
  if (needsReview.length > 0) console.log(`  ${needsReview.length} extracted/inferred`);
  console.log();

  let confirmed = 0;
  let discarded = 0;
  let lifecycled = 0;
  let lastGroup: string | null = null;

  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;

    if (r.group !== lastGroup) {
      lastGroup = r.group;
      const header = r.group === "audit_queue" ? "── Audit queue ──" : "── Extracted / inferred ──";
      console.log(`\n${header}\n`);
    }

    const sym = r.symbol ? `  [${r.symbol}]` : "";
    const svc = r.service ? `  ·service:${r.service}` : "";
    const score = r.priority_score > 0 ? `  priority:${r.priority_score}` : "";
    console.log(`[${i + 1}/${records.length}] ${r.type}  (${r.confidence})${sym}${svc}${score}`);
    console.log(`  ${r.content.slice(0, 160)}${r.content.length > 160 ? "…" : ""}`);
    console.log(`  ${actionsForType(r.type)}`);

    const answer = await prompt("> ");

    if (answer === "q") {
      console.log(`\nStopped. ${confirmed} confirmed, ${discarded} discarded, ${lifecycled} lifecycle actions.`);
      return;
    }

    if (answer === "s") {
      console.log("  → skipped\n");
      continue;
    }

    if (answer === "c") {
      await fetch(`${BASE_URL}/api/records/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: r.id, table: r.table }),
      });
      console.log("  ✓ confirmed\n");
      confirmed++;
      continue;
    }

    if (answer === "d") {
      await fetch(`${BASE_URL}/api/records/discard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: r.id, table: r.table }),
      });
      console.log("  ✗ discarded\n");
      discarded++;
      continue;
    }

    if (answer === "e") {
      const newContent = await prompt("  New content: ");
      if (newContent.trim()) {
        await fetch(`${BASE_URL}/api/records/edit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: r.id, table: r.table, content: newContent.trim() }),
        });
        await fetch(`${BASE_URL}/api/records/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: r.id, table: r.table }),
        });
        console.log("  ✓ updated and confirmed\n");
        confirmed++;
      }
      continue;
    }

    if (answer === "v") {
      await callLifecycle(r.id, r.table, "still_valid");
      console.log("  ✓ marked still valid (review timestamp updated)\n");
      lifecycled++;
      continue;
    }

    // Risk-specific actions
    if (answer === "m" && r.type === "risk") {
      const note = await prompt("  Mitigation note (optional): ");
      await callLifecycle(r.id, r.table, "mitigated", note || undefined);
      console.log("  ✓ marked mitigated\n");
      lifecycled++;
      continue;
    }

    if (answer === "a" && r.type === "risk") {
      const note = await prompt("  Acceptance rationale (optional): ");
      await callLifecycle(r.id, r.table, "accepted", note || undefined);
      console.log("  ✓ marked accepted\n");
      lifecycled++;
      continue;
    }

    // Deferred-specific actions
    if (answer === "done" && r.type === "deferred") {
      const note = await prompt("  Completion note (optional): ");
      await callLifecycle(r.id, r.table, "completed", note || undefined);
      console.log("  ✓ marked completed\n");
      lifecycled++;
      continue;
    }

    if (answer === "ab" && r.type === "deferred") {
      const note = await prompt("  Abandonment reason (optional): ");
      await callLifecycle(r.id, r.table, "abandoned", note || undefined);
      console.log("  ✓ marked abandoned\n");
      lifecycled++;
      continue;
    }

    console.log("  → skipped\n");
  }

  console.log(`\nReview complete: ${confirmed} confirmed, ${discarded} discarded, ${lifecycled} lifecycle actions.`);
}
