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
  confidence: string;
  content: string;
  symbol: string | null;
  created_at: number;
}

export async function runReview(): Promise<void> {
  await assertWorkerRunning();

  const repo = process.cwd();
  const res = await fetch(
    `${BASE_URL}/api/records/pending?repo=${encodeURIComponent(repo)}`,
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

  console.log(`\n${records.length} record${records.length !== 1 ? "s" : ""} pending review\n`);
  console.log("  [c] confirm   [e] edit content   [d] discard   [s] skip   [q] quit\n");

  let confirmed = 0;
  let discarded = 0;

  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    const sym = r.symbol ? `  [${r.symbol}]` : "";
    console.log(`[${i + 1}/${records.length}] ${r.type}  (${r.confidence})${sym}`);
    console.log(`  ${r.content.slice(0, 160)}${r.content.length > 160 ? "…" : ""}`);

    const answer = await prompt("> ");

    if (answer === "q") {
      console.log(`\nStopped. ${confirmed} confirmed, ${discarded} discarded.`);
      return;
    }

    if (answer === "c") {
      await fetch(`${BASE_URL}/api/records/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: r.id, table: r.table }),
      });
      console.log("  ✓ confirmed\n");
      confirmed++;
    } else if (answer === "d") {
      await fetch(`${BASE_URL}/api/records/discard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: r.id, table: r.table }),
      });
      console.log("  ✗ discarded\n");
      discarded++;
    } else if (answer === "e") {
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
    } else {
      console.log("  → skipped\n");
    }
  }

  console.log(`\nReview complete: ${confirmed} confirmed, ${discarded} discarded.`);
}
