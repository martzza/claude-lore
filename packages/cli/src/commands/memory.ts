const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";
const BASE = `http://127.0.0.1:${PORT}`;

interface MemoryRecord {
  id: string;
  content: string;
  tags: string | null;
  injected: number;
  created_at: number;
}

function workerError(): never {
  console.error("Worker not reachable — run: claude-lore worker start");
  process.exit(1);
}

// claude-lore remember "<text>" [--tag <tag>]
export async function runRemember(text: string, opts: { tag?: string }): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text, tags: opts.tag }),
    });
  } catch {
    workerError();
  }
  const data = (await res.json()) as { ok: boolean; id: string };
  if (data.ok) {
    const tagLabel = opts.tag ? ` [${opts.tag}]` : "";
    console.log(`✓ Remembered${tagLabel} (${data.id.slice(0, 8)})`);
    console.log(`  "${text}"`);
  }
}

// claude-lore memories [--tag <tag>] [--all]
export async function runMemories(opts: { tag?: string; all?: boolean }): Promise<void> {
  const params = new URLSearchParams();
  if (opts.tag) params.set("tag", opts.tag);
  if (opts.all) params.set("all", "true");

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/memory?${params.toString()}`);
  } catch {
    workerError();
  }
  const data = (await res.json()) as { ok: boolean; memories: MemoryRecord[] };
  const memories = data.memories ?? [];

  if (memories.length === 0) {
    console.log("No memories stored.");
    console.log('Add one:  claude-lore remember "<text>"');
    return;
  }

  const header = opts.tag
    ? `${memories.length} memor${memories.length === 1 ? "y" : "ies"} (tag: ${opts.tag})`
    : `${memories.length} memor${memories.length === 1 ? "y" : "ies"}`;
  console.log(`${header}:\n`);

  for (const m of memories) {
    const pausedLabel = m.injected ? "" : "  [paused]";
    const tagLabel = m.tags ? `  [${m.tags}]` : "";
    const date = new Date(m.created_at).toLocaleDateString();
    console.log(`  ${m.id.slice(0, 8)}  ${m.content}${tagLabel}${pausedLabel}  (${date})`);
  }

  if (!opts.all) {
    console.log("\n(showing injected only — use --all to include paused memories)");
  }
  console.log('\nRemove one:  claude-lore forget <id>');
}

// claude-lore forget [<id>] [--tag <tag>]
export async function runForget(id: string | undefined, opts: { tag?: string }): Promise<void> {
  if (!id && !opts.tag) {
    console.error("Provide an id or --tag <tag>");
    process.exit(1);
  }

  if (opts.tag) {
    const params = new URLSearchParams({ tag: opts.tag });
    let res: Response;
    try {
      res = await fetch(`${BASE}/api/memory?${params.toString()}`, { method: "DELETE" });
    } catch {
      workerError();
    }
    const data = (await res.json()) as { ok: boolean; deleted: number };
    console.log(
      `✓ Deleted ${data.deleted} memor${data.deleted === 1 ? "y" : "ies"} with tag: ${opts.tag}`,
    );
    return;
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/memory/${id}`, { method: "DELETE" });
  } catch {
    workerError();
  }
  const data = (await res.json()) as { ok: boolean };
  if (data.ok) {
    console.log(`✓ Deleted memory ${(id as string).slice(0, 8)}`);
  } else {
    console.log("Memory not found");
  }
}

// claude-lore memory pause <id> / resume <id>
export async function runMemorySetInjected(
  id: string,
  injected: boolean,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/memory/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ injected }),
    });
  } catch {
    workerError();
  }
  const data = (await res.json()) as { ok: boolean };
  if (data.ok) {
    console.log(`✓ Memory ${id.slice(0, 8)} ${injected ? "resumed" : "paused"}`);
  } else {
    console.log("Memory not found");
  }
}
