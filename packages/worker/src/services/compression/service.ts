import Anthropic from "@anthropic-ai/sdk";
import { getSessionObservations, isSessionComplete } from "../sessions/service.js";
import { saveDecision, saveDeferredWork, saveRisk, completeSession } from "../sessions/service.js";
import { createDraftAdr } from "../adr/service.js";

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

  // Persist extracted records (carry service through from session)
  for (const d of result.decisions ?? []) {
    await saveDecision(sessionId, repo, d.content, d.rationale, d.symbol, service);
  }
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

  await completeSession(sessionId, result.summary);
}
