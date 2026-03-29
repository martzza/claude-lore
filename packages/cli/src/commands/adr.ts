import { execSync } from "child_process";

const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";
const BASE = `http://127.0.0.1:${PORT}`;

async function assertWorker(): Promise<void> {
  try {
    await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
  } catch {
    console.error("Worker not running. Start it with: claude-lore worker start");
    process.exit(1);
  }
}

export async function adrList(): Promise<void> {
  await assertWorker();
  const repo = process.cwd();
  const res = await fetch(`${BASE}/api/adr/candidates?repo=${encodeURIComponent(repo)}`);
  const data = (await res.json()) as {
    candidates: Array<{ id: string; adr_title: string; confidence: string; created_at: number }>;
    count: number;
  };

  if (data.count === 0) {
    console.log("No pending ADR candidates.");
    return;
  }

  console.log(`\nPending ADR candidates (${data.count}):\n`);
  for (const adr of data.candidates) {
    const date = new Date(adr.created_at).toISOString().slice(0, 10);
    console.log(`  ${adr.id.slice(0, 8)}  [${adr.confidence}]  ${adr.adr_title}  (${date})`);
  }
  console.log(
    "\nConfirm: claude-lore adr confirm <id>  |  Archive: claude-lore adr discard <id>",
  );
}

export async function adrConfirm(id: string): Promise<void> {
  await assertWorker();
  const res = await fetch(`${BASE}/api/adr/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  const data = await res.json() as { ok?: boolean; error?: string };
  if (!data.ok) {
    console.error("Failed:", data.error);
    process.exit(1);
  }
  console.log(`ADR ${id.slice(0, 8)} accepted and confirmed.`);
}

export async function adrDiscard(id: string): Promise<void> {
  await assertWorker();
  const res = await fetch(`${BASE}/api/adr/discard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  const data = await res.json() as { ok?: boolean; error?: string };
  if (!data.ok) {
    console.error("Failed:", data.error);
    process.exit(1);
  }
  console.log(`ADR ${id.slice(0, 8)} archived (superseded).`);
}

export async function adrPostPr(): Promise<void> {
  await assertWorker();
  const repo = process.cwd();
  const res = await fetch(`${BASE}/api/adr/post-pr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo }),
  });
  const data = await res.json() as { count: number; results: Array<{ id: string; title: string; posted: boolean; method: string }> };
  if (data.count === 0) {
    console.log("No ADR candidates to post.");
    return;
  }
  for (const r of data.results) {
    const status = r.posted ? "posted via gh" : "printed to stdout";
    console.log(`  ${r.id.slice(0, 8)}  ${r.title}  — ${status}`);
  }
}
