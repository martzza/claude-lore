import { randomUUID } from "crypto";
import { sessionsDb } from "../sqlite/db.js";
import { getGitEmail } from "../sync/service.js";

// ---------------------------------------------------------------------------
// Signal patterns
// ---------------------------------------------------------------------------

const DECISION_SIGNALS = [
  /\b(decided|chose|choosing|selected|went with|will use|adopted|prefer(?:red)?)\b/i,
  /\b(instead of|rather than|over)\b.*\b(because|since|as)\b/i,
  /\b(architecture|design choice|approach|pattern|strategy)\b.*\b(is|was|will be)\b/i,
  /\b(using|switched to|migrated to|replaced with|moved to)\b/i,
];

const RISK_SIGNALS = [
  /\b(risk|concern|warning|danger|caution|caveat)\b/i,
  /\b(could fail|might break|watch out|be careful|note that)\b/i,
  /\b(vulnerability|security|constraint|limitation|never|must not|do not)\b/i,
  /\b(important|critical|blocking|blocked by)\b/i,
];

const DEFERRED_SIGNALS = [
  /\bTODO\b|\bFIXME\b|\bHACK\b/,
  /\b(defer|later|eventually|someday|parked|skip for now)\b/i,
  /\b(not now|not yet|phase \d|next sprint|backlog|future work)\b/i,
  /\b(haven't|haven't yet|will do|need to do|should do)\b/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SignalType = "decision" | "risk" | "deferred";

function classifyLine(line: string): SignalType | null {
  // Risk is checked first — risks often contain decision-like language
  if (RISK_SIGNALS.some((re) => re.test(line))) return "risk";
  if (DECISION_SIGNALS.some((re) => re.test(line))) return "decision";
  if (DEFERRED_SIGNALS.some((re) => re.test(line))) return "deferred";
  return null;
}

export function inferSeverity(content: string): "low" | "medium" | "high" {
  const upper = content.toUpperCase();
  if (/\b(CRITICAL|NEVER|MUST NOT|SECURITY|BLOCKED|BLOCKER)\b/.test(upper)) return "high";
  if (/\b(IMPORTANT|WARNING|CAUTION|CONCERN|RISK)\b/.test(upper)) return "medium";
  return "low";
}

/**
 * Extract text content from an observation row.
 * Real DB rows store text in `content`.
 * Hook-constructed rows may use `tool_input.prompt` (e.g. intent-signal).
 */
function extractContent(obs: Record<string, unknown>): string {
  if (typeof obs["content"] === "string" && obs["content"].length > 0) {
    return obs["content"];
  }
  // Fallback: intent-signal style observation with nested tool_input
  const toolInput = obs["tool_input"];
  if (toolInput && typeof toolInput === "object") {
    const prompt = (toolInput as Record<string, unknown>)["prompt"];
    if (typeof prompt === "string") return prompt;
  }
  return "";
}

// ---------------------------------------------------------------------------
// DB write helper
// ---------------------------------------------------------------------------

export interface ExtractedItem {
  type: SignalType;
  content: string;
  symbol?: string;
}

async function writeExtractedRecords(
  sessionId: string,
  repo: string,
  items: ExtractedItem[],
): Promise<void> {
  const now = Date.now();
  const createdBy = getGitEmail();

  for (const item of items) {
    const id = randomUUID();
    const source = "compression:rule_based";

    if (item.type === "decision") {
      await sessionsDb.execute({
        sql: `INSERT OR IGNORE INTO decisions
                (id, repo, session_id, symbol, content, confidence,
                 exported_tier, anchor_status, created_at, created_by, source)
              VALUES (?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', ?, ?, ?)`,
        args: [id, repo, sessionId, item.symbol ?? null, item.content, now, createdBy, source],
      });
    } else if (item.type === "risk") {
      await sessionsDb.execute({
        sql: `INSERT OR IGNORE INTO risks
                (id, repo, session_id, symbol, content, confidence,
                 exported_tier, anchor_status, created_at, created_by, source)
              VALUES (?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', ?, ?, ?)`,
        args: [id, repo, sessionId, item.symbol ?? null, item.content, now, createdBy, source],
      });
    } else {
      // deferred
      await sessionsDb.execute({
        sql: `INSERT OR IGNORE INTO deferred_work
                (id, repo, session_id, symbol, content, confidence,
                 exported_tier, anchor_status, status, created_at, created_by, source)
              VALUES (?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', 'open', ?, ?, ?)`,
        args: [id, repo, sessionId, item.symbol ?? null, item.content, now, createdBy, source],
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface RuleBasedResult {
  summary: string;
  decisions: ExtractedItem[];
  risks: ExtractedItem[];
  deferred: ExtractedItem[];
}

export async function runRuleBasedExtraction(
  sessionId: string,
  repo: string,
  observations: Array<Record<string, unknown>>,
): Promise<RuleBasedResult> {
  const items: ExtractedItem[] = [];

  for (const obs of observations) {
    const raw = extractContent(obs);
    // Split multi-line observations into individual lines for signal detection
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length < 20) continue; // too short to be meaningful
      const type = classifyLine(trimmed);
      if (type) {
        // Deduplicate: skip if we already have a very similar item
        const isDupe = items.some(
          (ex) => ex.type === type && ex.content.slice(0, 60) === trimmed.slice(0, 60),
        );
        if (!isDupe) {
          items.push({ type, content: trimmed.slice(0, 500) });
        }
      }
    }
  }

  await writeExtractedRecords(sessionId, repo, items);

  const decisions = items.filter((i) => i.type === "decision");
  const risks     = items.filter((i) => i.type === "risk");
  const deferred  = items.filter((i) => i.type === "deferred");

  const parts: string[] = [`Session ended with ${observations.length} observations.`];
  if (decisions.length + risks.length + deferred.length > 0) {
    parts.push(
      `Rule-based extraction found ${decisions.length} decision(s), ${risks.length} risk(s), ${deferred.length} deferred item(s).`,
    );
  }
  parts.push("Run compress_session MCP tool for higher-quality AI extraction.");

  return { summary: parts.join(" "), decisions, risks, deferred };
}
