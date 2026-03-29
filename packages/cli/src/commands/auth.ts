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

export async function runAuthGenerate(author: string, scopes: string[]): Promise<void> {
  await assertWorker();
  const res = await fetch(`${BASE}/api/auth/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ author, scopes }),
  });
  const data = (await res.json()) as { token: string; author: string; scopes: string[] };
  console.log(`\nToken generated for ${data.author}`);
  console.log(`Scopes: ${data.scopes.join(", ")}`);
  console.log(`\nToken (copy now — shown once):\n`);
  console.log(`  ${data.token}`);
  console.log(`\nSet via: Authorization: Bearer <token>`);
}

export async function runAuthList(): Promise<void> {
  await assertWorker();
  const res = await fetch(`${BASE}/api/auth/tokens`);
  const data = (await res.json()) as {
    tokens: Array<{ masked: string; author: string; scopes: string[]; created_at: number }>;
  };

  if (data.tokens.length === 0) {
    console.log("No tokens. Generate one with: claude-lore auth generate <author>");
    return;
  }

  console.log(`\nTokens (${data.tokens.length}):\n`);
  for (const t of data.tokens) {
    const date = new Date(t.created_at).toISOString().slice(0, 10);
    console.log(`  ${t.masked}  ${t.author.padEnd(30)} [${t.scopes.join(", ")}]  ${date}`);
  }
}

export async function runAuthRevoke(token: string): Promise<void> {
  await assertWorker();
  const res = await fetch(`${BASE}/api/auth/revoke`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const data = (await res.json()) as { removed: boolean };
  if (data.removed) {
    console.log("Token revoked.");
  } else {
    console.log("Token not found.");
  }
}
