import { sessionsDb } from "../sqlite/db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PatternType =
  | "context_switching"
  | "decision_after_impl"
  | "late_session_deferral"
  | "blast_radius_order"
  | "unconfirmed_accumulation"
  | "skill_usage_gap"
  | "no_lifecycle_review";

export interface WorkflowPattern {
  type: PatternType;
  frequency: number;
  description: string;
  impact: "positive" | "negative" | "neutral";
}

export type RecommendationCategory =
  | "sequencing"
  | "batching"
  | "session_length"
  | "decision_timing"
  | "context_switching";

export interface WorkflowRecommendation {
  priority: "high" | "medium" | "low";
  category: RecommendationCategory;
  title: string;
  detail: string;
  rationale: string;
}

export interface WorkflowAnalysis {
  repo: string;
  sessions_analysed: number;
  patterns: WorkflowPattern[];
  recommendations: WorkflowRecommendation[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

interface SessionRow {
  id: string;
  summary: string | null;
  started_at: number;
  ended_at: number | null;
}

interface ObsRow {
  session_id: string;
  tool_name: string;
  content: string;
  created_at: number;
}

interface DecisionRow {
  session_id: string;
  symbol: string | null;
  confidence: string;
  created_at: number;
}

function asSession(row: Record<string, unknown>): SessionRow {
  return {
    id: String(row["id"]),
    summary: row["summary"] != null ? String(row["summary"]) : null,
    started_at: Number(row["started_at"] ?? 0),
    ended_at: row["ended_at"] != null ? Number(row["ended_at"]) : null,
  };
}

function asObs(row: Record<string, unknown>): ObsRow {
  return {
    session_id: String(row["session_id"]),
    tool_name: String(row["tool_name"] ?? ""),
    content: String(row["content"] ?? ""),
    created_at: Number(row["created_at"] ?? 0),
  };
}

function asDecision(row: Record<string, unknown>): DecisionRow {
  return {
    session_id: String(row["session_id"]),
    symbol: row["symbol"] != null ? String(row["symbol"]) : null,
    confidence: String(row["confidence"] ?? "extracted"),
    created_at: Number(row["created_at"] ?? 0),
  };
}

/** Extract module name from file path or symbol (first path segment or prefix). */
function moduleOf(s: string): string {
  if (s.includes("/")) return s.split("/")[0] ?? s;
  // CamelCase prefix
  const match = s.match(/^[A-Z][a-z]+/);
  if (match) return match[0]!.toLowerCase();
  return s.split(/[._]/)[0] ?? s;
}

// ---------------------------------------------------------------------------
// Pattern detectors
// ---------------------------------------------------------------------------

function detectContextSwitching(
  sessions: SessionRow[],
  decisionsBySession: Map<string, DecisionRow[]>,
): WorkflowPattern | null {
  let highSwitchCount = 0;
  for (const session of sessions) {
    const decisions = decisionsBySession.get(session.id) ?? [];
    const symbols = decisions.map((d) => d.symbol).filter(Boolean) as string[];
    const modules = new Set(symbols.map(moduleOf));
    if (modules.size >= 3) highSwitchCount++;
  }
  if (highSwitchCount === 0) return null;
  const freq = sessions.length > 0 ? highSwitchCount / sessions.length : 0;
  return {
    type: "context_switching",
    frequency: highSwitchCount,
    description: `${highSwitchCount} of ${sessions.length} sessions touched 3+ unrelated modules (${Math.round(freq * 100)}% of sessions).`,
    impact: freq > 0.4 ? "negative" : "neutral",
  };
}

function detectDecisionAfterImpl(
  sessions: SessionRow[],
  observationsBySession: Map<string, ObsRow[]>,
  decisionsBySession: Map<string, DecisionRow[]>,
): WorkflowPattern | null {
  let count = 0;
  for (const session of sessions) {
    const observations = observationsBySession.get(session.id) ?? [];
    const decisions = decisionsBySession.get(session.id) ?? [];
    if (decisions.length === 0 || observations.length === 0) continue;

    const firstDecisionAt = Math.min(...decisions.map((d) => d.created_at));
    const writeObs = observations.filter((o) =>
      ["Write", "Edit", "Bash"].includes(o.tool_name),
    );
    if (writeObs.length === 0) continue;

    const firstWriteAt = Math.min(...writeObs.map((o) => o.created_at));
    // Decision came more than 30 seconds after first write
    if (firstDecisionAt > firstWriteAt + 30_000) count++;
  }
  if (count === 0) return null;
  return {
    type: "decision_after_impl",
    frequency: count,
    description: `In ${count} sessions, decisions were captured after implementation started.`,
    impact: count > sessions.length * 0.3 ? "negative" : "neutral",
  };
}

function detectLateSessionDeferral(
  sessions: SessionRow[],
  observationsBySession: Map<string, ObsRow[]>,
  deferredBySession: Map<string, number>,
): WorkflowPattern | null {
  let count = 0;
  for (const session of sessions) {
    const obs = observationsBySession.get(session.id) ?? [];
    if (obs.length < 5) continue;
    const deferredCount = deferredBySession.get(session.id) ?? 0;
    if (deferredCount === 0) continue;

    // Check if deferred items were created in last 20% of session
    const sorted = obs.slice().sort((a, b) => a.created_at - b.created_at);
    const start = sorted[0]!.created_at;
    const end = sorted[sorted.length - 1]!.created_at;
    const duration = end - start;
    if (duration < 60_000) continue; // too short to matter

    const lateThreshold = start + duration * 0.8;
    const lateObs = sorted.filter((o) => o.created_at >= lateThreshold);
    const hasDeferralKeywords = lateObs.some((o) =>
      /defer|todo|later|next|skip|park/i.test(o.content),
    );
    if (hasDeferralKeywords) count++;
  }
  if (count === 0) return null;
  return {
    type: "late_session_deferral",
    frequency: count,
    description: `In ${count} sessions, work items appear to have been deferred in the final 20% of the session.`,
    impact: count > 2 ? "negative" : "neutral",
  };
}

async function detectUnconfirmedAccumulation(
  repo: string,
  sessions: SessionRow[],
): Promise<WorkflowPattern | null> {
  if (sessions.length < 3) return null;

  const res = await sessionsDb.execute({
    sql: `SELECT COUNT(*) as c FROM decisions
          WHERE repo = ? AND confidence IN ('extracted', 'inferred')`,
    args: [repo],
  });
  const confirmedRes = await sessionsDb.execute({
    sql: `SELECT COUNT(*) as c FROM decisions
          WHERE repo = ? AND confidence = 'confirmed'`,
    args: [repo],
  });
  const extracted = Number((res.rows[0] as Record<string, unknown>)["c"] ?? 0);
  const confirmed = Number((confirmedRes.rows[0] as Record<string, unknown>)["c"] ?? 0);

  if (extracted + confirmed === 0) return null;
  const ratio = extracted / (extracted + confirmed);
  if (ratio < 0.7) return null; // less than 70% unconfirmed — ok

  return {
    type: "unconfirmed_accumulation",
    frequency: extracted,
    description: `${extracted} extracted records vs ${confirmed} confirmed (${Math.round(ratio * 100)}% unreviewed).`,
    impact: ratio > 0.9 ? "negative" : "neutral",
  };
}

// ---------------------------------------------------------------------------
// Recommendation builders
// ---------------------------------------------------------------------------

function buildRecommendations(
  patterns: WorkflowPattern[],
  sessions: SessionRow[],
): WorkflowRecommendation[] {
  const recs: WorkflowRecommendation[] = [];
  const patternMap = new Map(patterns.map((p) => [p.type, p]));

  const ctxSwitch = patternMap.get("context_switching");
  if (ctxSwitch && ctxSwitch.impact === "negative") {
    recs.push({
      priority: "medium",
      category: "batching",
      title: "Batch related-module work into dedicated sessions",
      detail: `${ctxSwitch.frequency} sessions touched 3+ unrelated modules. Context switching has a measurable cost — consider grouping auth-related work in one session, DB work in another.`,
      rationale: `Session data shows cross-module context switching in ${ctxSwitch.frequency} sessions.`,
    });
  }

  const decAfterImpl = patternMap.get("decision_after_impl");
  if (decAfterImpl && decAfterImpl.impact === "negative") {
    recs.push({
      priority: "medium",
      category: "decision_timing",
      title: "Draft decisions before implementing complex changes",
      detail: "Decisions are often captured after implementation begins. A brief ADR draft (use `/lore log decision`) before starting reduces rework when the approach needs to change mid-implementation.",
      rationale: `Decisions were captured after implementation started in ${decAfterImpl.frequency} sessions.`,
    });
  }

  const lateDeferral = patternMap.get("late_session_deferral");
  if (lateDeferral && lateDeferral.impact === "negative") {
    recs.push({
      priority: "low",
      category: "session_length",
      title: "Defer intentionally at session midpoint, not at end",
      detail: "Work items are often parked in the final minutes. Set a soft midpoint check — at 50% of expected session time, review what's in scope and defer anything that won't fit.",
      rationale: `Late-session deferral detected in ${lateDeferral.frequency} sessions.`,
    });
  }

  const unconfirmed = patternMap.get("unconfirmed_accumulation");
  if (unconfirmed) {
    const extractedCount = unconfirmed.frequency;
    recs.push({
      priority: extractedCount > 20 ? "high" : "medium",
      category: "decision_timing",
      title: `Review ${extractedCount} accumulated extracted records`,
      detail: `Run \`claude-lore review\` to promote key records to confirmed. Unconfirmed records are presented with less authority to future agents — confirming them improves context quality.`,
      rationale: `${extractedCount} records are extracted but unconfirmed.`,
    });
  }

  const noReview = patternMap.get("no_lifecycle_review");
  if (noReview) {
    recs.push({
      priority: "medium",
      category: "sequencing",
      title: "Schedule a lifecycle review",
      detail:
        `Records accumulate faster than they're confirmed. A 15-minute review session ` +
        `would address the backlog. Run: claude-lore review`,
      rationale: noReview.description,
    });
  }

  // If session count is high and no review has happened, suggest batching reviews
  if (sessions.length >= 10 && !patternMap.has("unconfirmed_accumulation")) {
    recs.push({
      priority: "low",
      category: "decision_timing",
      title: "Schedule periodic record review sessions",
      detail: `After ${sessions.length} sessions, periodic review of extracted records keeps the knowledge base accurate. A 10-minute \`claude-lore review\` session every week or two is usually sufficient.`,
      rationale: `${sessions.length} sessions without a structured review pass.`,
    });
  }

  // Sequencing recommendation for any repo with decisions
  if (sessions.length >= 5) {
    recs.push({
      priority: "low",
      category: "sequencing",
      title: "Lead sessions with highest-blast-radius work",
      detail: "When a session involves both high-impact and low-impact changes, tackle the high-blast-radius symbols first while context is fresh. Use `claude-lore advisor parallel --from-deferred` to identify parallel opportunities.",
      rationale: "General sequencing best practice for multi-symbol sessions.",
    });
  }

  return recs.slice(0, 5); // cap at 5 recommendations
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export async function analyseWorkflow(
  repo: string,
  days: number,
  service?: string,
): Promise<WorkflowAnalysis> {
  const cutoff = Date.now() - days * MS_PER_DAY;

  const sessionArgs: (string | number | null)[] = [repo, cutoff];
  const svcClause = service !== undefined ? "AND service IS ?" : "";
  if (service !== undefined) sessionArgs.push(service ?? null);

  // Load sessions in window
  const sessionRes = await sessionsDb.execute({
    sql: `SELECT id, summary, started_at, ended_at
          FROM sessions
          WHERE repo = ? AND status = 'complete' AND started_at >= ? ${svcClause}
          ORDER BY started_at ASC`,
    args: sessionArgs,
  });
  const sessions = sessionRes.rows.map((r) => asSession(r as Record<string, unknown>));

  if (sessions.length === 0) {
    return {
      repo,
      sessions_analysed: 0,
      patterns: [],
      recommendations: [],
    };
  }

  const sessionIds = sessions.map((s) => s.id);

  // Load observations for all sessions
  const obsRes = await sessionsDb.execute({
    sql: `SELECT session_id, tool_name, content, created_at
          FROM observations
          WHERE session_id IN (${sessionIds.map(() => "?").join(",")})
          ORDER BY created_at ASC`,
    args: sessionIds,
  });
  const allObs = obsRes.rows.map((r) => asObs(r as Record<string, unknown>));

  // Load decisions for all sessions
  const decRes = await sessionsDb.execute({
    sql: `SELECT session_id, symbol, confidence, created_at
          FROM decisions
          WHERE repo = ? AND session_id IN (${sessionIds.map(() => "?").join(",")})`,
    args: [repo, ...sessionIds],
  });
  const allDecisions = decRes.rows.map((r) => asDecision(r as Record<string, unknown>));

  // Load deferred work per session
  const deferredRes = await sessionsDb.execute({
    sql: `SELECT session_id, COUNT(*) as c
          FROM deferred_work
          WHERE repo = ? AND session_id IN (${sessionIds.map(() => "?").join(",")})
          GROUP BY session_id`,
    args: [repo, ...sessionIds],
  });

  // Build per-session maps
  const observationsBySession = new Map<string, ObsRow[]>();
  const decisionsBySession = new Map<string, DecisionRow[]>();
  const deferredBySession = new Map<string, number>();

  for (const obs of allObs) {
    const existing = observationsBySession.get(obs.session_id) ?? [];
    existing.push(obs);
    observationsBySession.set(obs.session_id, existing);
  }
  for (const dec of allDecisions) {
    const existing = decisionsBySession.get(dec.session_id) ?? [];
    existing.push(dec);
    decisionsBySession.set(dec.session_id, existing);
  }
  for (const row of deferredRes.rows) {
    const r = row as Record<string, unknown>;
    deferredBySession.set(String(r["session_id"]), Number(r["c"] ?? 0));
  }

  // Run pattern detectors
  const patterns: WorkflowPattern[] = [];

  const ctxSwitch = detectContextSwitching(sessions, decisionsBySession);
  if (ctxSwitch) patterns.push(ctxSwitch);

  const decAfterImpl = detectDecisionAfterImpl(sessions, observationsBySession, decisionsBySession);
  if (decAfterImpl) patterns.push(decAfterImpl);

  const lateDeferral = detectLateSessionDeferral(sessions, observationsBySession, deferredBySession);
  if (lateDeferral) patterns.push(lateDeferral);

  const unconfirmed = await detectUnconfirmedAccumulation(repo, sessions);
  if (unconfirmed) patterns.push(unconfirmed);

  // Lifecycle review cadence — no records reviewed in the last 30 days
  const lastReviewRes = await sessionsDb.execute({
    sql: `SELECT MAX(last_reviewed_at) as latest
          FROM (
            SELECT last_reviewed_at FROM decisions WHERE repo = ?
            UNION ALL
            SELECT last_reviewed_at FROM risks WHERE repo = ?
            UNION ALL
            SELECT last_reviewed_at FROM deferred_work WHERE repo = ?
          )`,
    args: [repo, repo, repo],
  });
  const lastReviewedAt = (lastReviewRes.rows[0] as Record<string, unknown>)["latest"];
  const lastReviewSec = lastReviewedAt != null ? Number(lastReviewedAt) : null;
  const daysSinceReview = lastReviewSec != null
    ? (Date.now() / 1000 - lastReviewSec) / 86400
    : Infinity;

  if (daysSinceReview > 30) {
    patterns.push({
      type: "no_lifecycle_review",
      frequency: 1,
      description: `No records have been reviewed in ${Math.round(daysSinceReview) === Infinity ? "ever" : Math.round(daysSinceReview) + " days"}`,
      impact: "negative",
    });
  }

  const recommendations = buildRecommendations(patterns, sessions);

  return {
    repo,
    sessions_analysed: sessions.length,
    patterns,
    recommendations,
  };
}
