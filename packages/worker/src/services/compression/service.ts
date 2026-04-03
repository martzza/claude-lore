import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import { getSessionObservations, isSessionComplete, saveDeferredWork, saveRisk, completeSession } from "../sessions/service.js";
import { sessionsDb } from "../sqlite/db.js";
import { createDraftAdr } from "../adr/service.js";
import { getGitEmail } from "../sync/service.js";

const client = new Anthropic();

interface CompressionResult {
  summary: string;
  symbols_touched: string[];
  decisions: Array<{ content: string; rationale?: string; symbol?: string }>;
  deferred: Array<{ content: string; symbol?: string }>;
  risks: Array<{ content: string; symbol?: string }>;
  adr_candidates: string[];
}

const COMPRESSION_PROMPT = `You are summarising an AI coding session for a knowledge graph.

Given the raw session observations below, extract a structured JSON object with these fields:
- summary: 2-3 sentence summary of what happened this session
- symbols_touched: array of symbol/function/class names that were referenced or modified
- decisions: array of architectural decisions made (content, optional rationale, optional symbol)
- deferred: array of work items explicitly parked for later (content, optional symbol)
- risks: array of risks or constraints identified (content, optional symbol)
- adr_candidates: array of decisions worth formal ADR review (strings)

All extracted records have confidence "extracted" — never write "confirmed".

Return ONLY valid JSON, no markdown fences.`;

// ---------------------------------------------------------------------------
// Supersession detection helpers
// ---------------------------------------------------------------------------

/** Token overlap similarity between two strings (0.0 – 1.0). */
function tokenSimilarity(a: string, b: string): number {
  const tok = (s: string) =>
    new Set(s.toLowerCase().split(/\W+/).filter((t) => t.length > 3));
  const ta = tok(a);
  const tb = tok(b);
  const intersection = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : intersection / union;
}

const SUPERSESSION_PHRASES = [
  "switch to", "migrate to", "replace", "instead of",
  "no longer", "moved from", "dropped", "removed",
  "updated to", "changed to", "now using",
] as const;

function isLikelySupersession(newContent: string, oldContent: string): boolean {
  const lower = newContent.toLowerCase();
  return (
    SUPERSESSION_PHRASES.some((p) => lower.includes(p)) &&
    tokenSimilarity(newContent, oldContent) > 0.3
  );
}

/** Returns { candidateId, similarity } when a near-duplicate decision exists, null otherwise. */
async function findSupersessionCandidate(
  repo: string,
  symbol: string | null,
  newContent: string,
): Promise<{ candidateId: string; similarity: number } | null> {
  const res = await sessionsDb.execute({
    sql: `SELECT id, content
          FROM decisions
          WHERE repo = ?
            AND lifecycle_status = 'active'
            AND deprecated_by IS NULL
            AND (symbol = ? OR (? IS NULL AND symbol IS NULL) OR symbol IS NULL OR ? IS NULL)
          ORDER BY created_at DESC
          LIMIT 30`,
    args: [repo, symbol, symbol, symbol],
  });

  let best: { candidateId: string; similarity: number } | null = null;

  for (const row of res.rows) {
    const r = row as Record<string, unknown>;
    const existing = String(r["content"] ?? "");
    const sim = tokenSimilarity(newContent, existing);
    const supersession = isLikelySupersession(newContent, existing);

    const effectiveSim = supersession ? Math.max(sim, 0.45) : sim;
    if (effectiveSim > 0.4 && (!best || effectiveSim > best.similarity)) {
      best = { candidateId: String(r["id"]), similarity: effectiveSim };
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Zombie detection: persist symbols_touched to open deferred items
// ---------------------------------------------------------------------------

async function updateTouchedBySessions(
  repo: string,
  sessionId: string,
  symbolsTouched: string[],
): Promise<void> {
  if (symbolsTouched.length === 0) return;

  for (const symbol of symbolsTouched) {
    const items = await sessionsDb.execute({
      sql: `SELECT id, touched_by_sessions
            FROM deferred_work
            WHERE repo = ?
              AND symbol = ?
              AND lifecycle_status = 'active'
              AND deprecated_by IS NULL`,
      args: [repo, symbol],
    });

    for (const row of items.rows) {
      const r = row as Record<string, unknown>;
      let sessions: string[] = [];
      try {
        sessions = JSON.parse(String(r["touched_by_sessions"] ?? "[]")) as string[];
      } catch { /* malformed JSON — reset */ }

      if (!sessions.includes(sessionId)) {
        sessions.push(sessionId);
        await sessionsDb.execute({
          sql: `UPDATE deferred_work SET touched_by_sessions = ? WHERE id = ?`,
          args: [JSON.stringify(sessions), String(r["id"])],
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Decision save with supersession awareness
// ---------------------------------------------------------------------------

async function saveDecisionWithSupersession(
  sessionId: string,
  repo: string,
  content: string,
  rationale: string | undefined,
  symbol: string | undefined,
  service: string | undefined,
): Promise<void> {
  const candidate = await findSupersessionCandidate(repo, symbol ?? null, content);
  const id = randomUUID();
  const now = Date.now();
  const createdBy = getGitEmail();

  if (candidate && candidate.similarity > 0.6) {
    // High confidence supersession — write new record with supersedes link
    await sessionsDb.execute({
      sql: `INSERT OR IGNORE INTO decisions
              (id, repo, session_id, symbol, content, rationale, confidence,
               exported_tier, anchor_status, created_at, service, created_by, supersedes)
            VALUES (?, ?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', ?, ?, ?, ?)`,
      args: [id, repo, sessionId, symbol ?? null, content, rationale ?? null, now, service ?? null, createdBy, candidate.candidateId],
    });
    // Mark the old decision as superseded
    await sessionsDb.execute({
      sql: `UPDATE decisions
            SET lifecycle_status = 'superseded',
                superseded_by = ?,
                superseded_at = unixepoch()
            WHERE id = ? AND lifecycle_status = 'active'`,
      args: [id, candidate.candidateId],
    });
  } else if (candidate && candidate.similarity > 0.4) {
    // Uncertain — mark existing as contested but still write new record
    await sessionsDb.execute({
      sql: `INSERT OR IGNORE INTO decisions
              (id, repo, session_id, symbol, content, rationale, confidence,
               exported_tier, anchor_status, created_at, service, created_by)
            VALUES (?, ?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', ?, ?, ?)`,
      args: [id, repo, sessionId, symbol ?? null, content, rationale ?? null, now, service ?? null, createdBy],
    });
    await sessionsDb.execute({
      sql: `UPDATE decisions SET confidence = 'contested' WHERE id = ? AND confidence != 'confirmed'`,
      args: [candidate.candidateId],
    });
  } else {
    // No candidate — plain write
    await sessionsDb.execute({
      sql: `INSERT OR IGNORE INTO decisions
              (id, repo, session_id, symbol, content, rationale, confidence,
               exported_tier, anchor_status, created_at, service, created_by)
            VALUES (?, ?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', ?, ?, ?)`,
      args: [id, repo, sessionId, symbol ?? null, content, rationale ?? null, now, service ?? null, createdBy],
    });
  }
}

// ---------------------------------------------------------------------------
// Main compression pass
// ---------------------------------------------------------------------------

export async function runCompressionPass(
  sessionId: string,
  repo: string,
  service?: string,
): Promise<void> {
  // Guard: skip if session already completed (Stop hook fired twice)
  if (await isSessionComplete(sessionId)) return;

  const observations = await getSessionObservations(sessionId);

  if (observations.length === 0) {
    await completeSession(sessionId, "No observations recorded this session.");
    return;
  }

  const observationText = observations
    .map((o) => {
      const obs = o as Record<string, unknown>;
      return `[${String(obs["tool_name"] ?? "note")}] ${String(obs["content"])}`;
    })
    .join("\n");

  let result: CompressionResult;
  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `${COMPRESSION_PROMPT}\n\n## Observations\n${observationText}`,
        },
      ],
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    result = JSON.parse(text) as CompressionResult;
  } catch (err) {
    // Fallback: mark complete with raw observation count
    await completeSession(
      sessionId,
      `Session ended with ${observations.length} observations. Compression failed: ${String(err)}`,
    );
    return;
  }

  // Persist decisions with supersession detection
  for (const d of result.decisions ?? []) {
    await saveDecisionWithSupersession(sessionId, repo, d.content, d.rationale, d.symbol, service);
  }

  // Persist deferred and risks (no supersession logic — these accumulate)
  for (const d of result.deferred ?? []) {
    await saveDeferredWork(sessionId, repo, d.content, d.symbol, service);
  }
  for (const r of result.risks ?? []) {
    await saveRisk(sessionId, repo, r.content, r.symbol, service);
  }

  // Tag decisions nominated as ADR candidates with adr_status='draft'
  for (const candidate of result.adr_candidates ?? []) {
    await createDraftAdr(repo, candidate, candidate, undefined, undefined, undefined, sessionId);
  }

  // Persist symbols_touched to open deferred items for zombie detection
  await updateTouchedBySessions(repo, sessionId, result.symbols_touched ?? []);

  await completeSession(sessionId, result.summary);
}
