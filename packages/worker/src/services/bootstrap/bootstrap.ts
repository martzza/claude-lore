import { createHash } from "crypto";
import { sessionsDb } from "../sqlite/db.js";
import { buildRegistry } from "./registry.js";
import type { BootstrapRunOptions, BootstrapRunResult, GeneratedRecord } from "./types.js";

/** Deterministic UUID derived from source + repo + content — identical inputs → identical ID */
function deterministicId(source: string, repo: string, content: string): string {
  const hash = createHash("sha256").update(`${source}|${repo}|${content}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

async function writeRecord(record: GeneratedRecord, repo: string, source: string): Promise<void> {
  const id = deterministicId(source, repo, record.content);
  const now = Date.now();

  if (record.type === "decision") {
    await sessionsDb.execute({
      sql: `INSERT OR IGNORE INTO decisions
              (id, repo, session_id, symbol, content, rationale, confidence, exported_tier, anchor_status, source, created_at)
            VALUES (?, ?, NULL, ?, ?, ?, 'inferred', ?, 'healthy', ?, ?)`,
      args: [
        id,
        repo,
        record.symbol ?? null,
        record.content,
        record.rationale ?? null,
        record.exported_tier,
        source,
        now,
      ],
    });
  } else if (record.type === "deferred") {
    await sessionsDb.execute({
      sql: `INSERT OR IGNORE INTO deferred_work
              (id, repo, session_id, symbol, content, confidence, exported_tier, anchor_status, status, source, created_at)
            VALUES (?, ?, NULL, ?, ?, 'inferred', ?, 'healthy', 'open', ?, ?)`,
      args: [id, repo, record.symbol ?? null, record.content, record.exported_tier, source, now],
    });
  } else {
    await sessionsDb.execute({
      sql: `INSERT OR IGNORE INTO risks
              (id, repo, session_id, symbol, content, confidence, exported_tier, anchor_status, source, created_at)
            VALUES (?, ?, NULL, ?, ?, 'inferred', ?, 'healthy', ?, ?)`,
      args: [id, repo, record.symbol ?? null, record.content, record.exported_tier, source, now],
    });
  }
}

export interface DeduplicateResult {
  decisions: number;
  risks: number;
  deferred: number;
}

/** Delete duplicate records (same repo + content), keeping the oldest per group */
export async function deduplicateBootstrapRecords(repo: string): Promise<DeduplicateResult> {
  const result: DeduplicateResult = { decisions: 0, risks: 0, deferred: 0 };

  const tables: Array<{ table: string; key: keyof DeduplicateResult }> = [
    { table: "decisions", key: "decisions" },
    { table: "risks", key: "risks" },
    { table: "deferred_work", key: "deferred" },
  ];

  for (const { table, key } of tables) {
    // Find all IDs to keep — one per (repo, content) group, picked by MIN(created_at, id)
    const keepResult = await sessionsDb.execute({
      sql: `SELECT MIN(id) as keep_id FROM ${table} WHERE repo = ? GROUP BY content`,
      args: [repo],
    });
    const keepIds = keepResult.rows.map((r) => r["keep_id"] as string).filter(Boolean);

    if (keepIds.length === 0) continue;

    // Count how many will be deleted
    const placeholders = keepIds.map(() => "?").join(",");
    const countResult = await sessionsDb.execute({
      sql: `SELECT COUNT(*) as n FROM ${table} WHERE repo = ? AND id NOT IN (${placeholders})`,
      args: [repo, ...keepIds],
    });
    result[key] = Number(countResult.rows[0]?.["n"] ?? 0);

    if (result[key] > 0) {
      await sessionsDb.execute({
        sql: `DELETE FROM ${table} WHERE repo = ? AND id NOT IN (${placeholders})`,
        args: [repo, ...keepIds],
      });
    }
  }

  return result;
}

export async function runBootstrap(opts: BootstrapRunOptions): Promise<BootstrapRunResult[]> {
  const { repo, templateIds, dryRun = false } = opts;
  const registry = await buildRegistry(repo);

  const templates = templateIds
    ? templateIds.map((id) => {
        const t = registry.get(id);
        if (!t) throw new Error(`Template not found: ${id}`);
        return t;
      })
    : Array.from(registry.values());

  const context = { repo, timestamp: Date.now() };
  const results: BootstrapRunResult[] = [];

  for (const template of templates) {
    // Use default answers for all questions (non-interactive path for API)
    const answers: Record<string, unknown> = {};
    for (const q of template.questions) {
      answers[q.id] = q.default ?? (q.type === "confirm" ? true : "");
    }

    const records = template.generate(answers, context);
    const source = `template:${template.id}`;

    if (!dryRun) {
      for (const record of records) {
        await writeRecord(record, repo, source);
      }
    }

    results.push({
      template: template.id,
      records,
      written: dryRun ? 0 : records.length,
      dry_run: dryRun,
    });
  }

  return results;
}
