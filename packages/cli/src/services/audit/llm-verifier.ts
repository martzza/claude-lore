import Anthropic from "@anthropic-ai/sdk";
import type { ClassifiedClaim } from "./record-classifier.js";
import { buildVerificationContext } from "./claim-extractor.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LlmVerdict = "verified" | "gap" | "unknown";

export interface LlmVerificationResult {
  verdict: LlmVerdict;
  reasoning: string;
  /** Input tokens used (for cost tracking) */
  inputTokens: number;
  /** Output tokens used */
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a code auditor for a knowledge graph system called claude-lore.
Your job is to verify whether a documented claim about a codebase is accurate based on provided code snippets.

Respond with ONLY a JSON object (no markdown fences):
{
  "verdict": "verified" | "gap" | "unknown",
  "reasoning": "one sentence explanation"
}

Verdicts:
- "verified": the code clearly implements or supports the claim
- "gap": the code does not implement what the claim describes, or the claim describes intended behavior not present in code
- "unknown": the snippets are insufficient to judge (e.g. claim is about runtime behavior, not visible in static code)`;

function buildUserPrompt(claim: string, snippets: Record<string, string>, isNoCode: boolean): string {
  const lines: string[] = [];

  lines.push(`Claim to verify:\n"${claim}"`);

  if (isNoCode) {
    lines.push("\nNo code was found matching the key terms from this claim.");
    lines.push('Consider: is this claim about something that should be visible in source code? If yes, verdict is likely "gap".');
    lines.push('If the claim is purely conceptual/architectural (not code-verifiable), use "unknown".');
  } else {
    lines.push("\nRelevant code snippets:");
    for (const [label, snippet] of Object.entries(snippets)) {
      lines.push(`\n--- ${label} ---\n${snippet}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Anthropic client (lazy init — only created when LLM mode is used)
// ---------------------------------------------------------------------------

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable not set.\n" +
        "Set it to use LLM verification, or run with --grep-only to skip LLM.",
      );
    }
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Verification call
// ---------------------------------------------------------------------------

const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 256;

export async function verifyWithLlm(claim: ClassifiedClaim): Promise<LlmVerificationResult> {
  const ctx = buildVerificationContext(claim);
  const userPrompt = buildUserPrompt(ctx.claim, ctx.snippets, ctx.isNoCode);

  const client = getClient();
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  let verdict: LlmVerdict = "unknown";
  let reasoning = "";

  try {
    // Strip any accidental markdown fences
    const cleaned = text.replace(/^```[a-z]*\n?/m, "").replace(/```$/m, "").trim();
    const parsed = JSON.parse(cleaned) as { verdict?: string; reasoning?: string };
    if (parsed.verdict === "verified" || parsed.verdict === "gap" || parsed.verdict === "unknown") {
      verdict = parsed.verdict;
    }
    reasoning = parsed.reasoning ?? "";
  } catch {
    // Non-JSON response — treat as unknown
    reasoning = text.slice(0, 200);
  }

  return {
    verdict,
    reasoning,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}

// ---------------------------------------------------------------------------
// Batch verification with concurrency cap
// ---------------------------------------------------------------------------

const MAX_CONCURRENT = 3;

export interface BatchVerifyResult {
  claim: ClassifiedClaim;
  llmResult: LlmVerificationResult;
}

export async function verifyBatch(
  claims: ClassifiedClaim[],
  onProgress?: (done: number, total: number) => void,
): Promise<BatchVerifyResult[]> {
  const results: BatchVerifyResult[] = [];
  let done = 0;

  // Process in chunks of MAX_CONCURRENT
  for (let i = 0; i < claims.length; i += MAX_CONCURRENT) {
    const chunk = claims.slice(i, i + MAX_CONCURRENT);
    const chunkResults = await Promise.all(
      chunk.map(async (claim) => {
        const llmResult = await verifyWithLlm(claim);
        done++;
        onProgress?.(done, claims.length);
        return { claim, llmResult };
      }),
    );
    results.push(...chunkResults);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Cost summary helper
// ---------------------------------------------------------------------------

export interface LlmCostSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

export function summariseCost(results: BatchVerifyResult[]): LlmCostSummary {
  const calls = results.length;
  const inputTokens = results.reduce((s, r) => s + r.llmResult.inputTokens, 0);
  const outputTokens = results.reduce((s, r) => s + r.llmResult.outputTokens, 0);
  const estimatedUsd = (inputTokens / 1_000_000) * 3.0 + (outputTokens / 1_000_000) * 15.0;
  return { calls, inputTokens, outputTokens, estimatedUsd };
}
