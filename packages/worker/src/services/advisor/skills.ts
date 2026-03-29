import { sessionsDb } from "../sqlite/db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SuggestionReason =
  | "repeated_symbol"    // symbol appears in 5+ sessions
  | "repeated_task"      // task pattern repeated 4+ times
  | "deferred_cluster"   // 3+ deferred items sharing a topic keyword
  | "missing_doc";       // symbol has decisions but no skill covers it

export interface SkillSuggestion {
  reason: SuggestionReason;
  name: string;
  description: string;
  evidence: string[];   // up to 5 supporting examples
  priority: "high" | "medium" | "low";
}

export interface SkillGapAnalysis {
  repo: string;
  generated_at: number;
  sessions_analysed: number;
  suggestions: SkillSuggestion[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4)
    .slice(0, 10);
}

/** Find the most common keyword across an array of strings, min occurrences */
function topKeyword(
  texts: string[],
  minOccurrences: number,
): string | null {
  const freq = new Map<string, number>();
  for (const t of texts) {
    for (const w of extractKeywords(t)) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestCount = minOccurrences - 1;
  for (const [word, count] of freq) {
    if (count > bestCount) {
      best = word;
      bestCount = count;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export async function analyseSkillGaps(
  repo: string,
  days: number,
): Promise<SkillGapAnalysis> {
  const now = Date.now();
  const cutoff = now - days * MS_PER_DAY;
  const suggestions: SkillSuggestion[] = [];

  // Count sessions in window
  const sessionCountRes = await sessionsDb.execute({
    sql: `SELECT COUNT(*) as c FROM sessions
          WHERE repo = ? AND status = 'complete' AND started_at >= ?`,
    args: [repo, cutoff],
  });
  const sessionsAnalysed = Number(sessionCountRes.rows[0]?.["c"] ?? 0);

  // 1. repeated_symbol — symbols appearing in 5+ distinct sessions
  const symbolRes = await sessionsDb.execute({
    sql: `SELECT d.symbol, COUNT(DISTINCT d.session_id) as session_count,
               GROUP_CONCAT(SUBSTR(d.content, 1, 80), '|||') as samples
          FROM decisions d
          JOIN sessions s ON s.id = d.session_id
          WHERE d.repo = ? AND d.symbol IS NOT NULL AND s.started_at >= ?
          GROUP BY d.symbol
          HAVING session_count >= 5
          ORDER BY session_count DESC
          LIMIT 10`,
    args: [repo, cutoff],
  });

  // Collect skill names already indexed (treat as coverage proxy)
  const coveredRes = await sessionsDb.execute({
    sql: `SELECT skill_name FROM skill_manifest WHERE repo = ? OR repo = 'global'`,
    args: [repo],
  });
  const coveredSymbols = new Set(
    coveredRes.rows.map((r) =>
      String((r as Record<string, unknown>)["skill_name"]).toLowerCase(),
    ),
  );

  for (const row of symbolRes.rows) {
    const r = row as Record<string, unknown>;
    const sym = String(r["symbol"]);
    const isCovered = Array.from(coveredSymbols).some((name) =>
      name.includes(sym.toLowerCase()) || sym.toLowerCase().includes(name),
    );
    if (isCovered) continue;
    const sessionCount = Number(r["session_count"]);
    const rawSamples = String(r["samples"] ?? "").split("|||").slice(0, 5);
    suggestions.push({
      reason: "repeated_symbol",
      name: `${sym}-workflow`,
      description: `Create a skill for \`${sym}\` — it has appeared in ${sessionCount} sessions but has no dedicated skill.`,
      evidence: rawSamples,
      priority: sessionCount >= 10 ? "high" : "medium",
    });
  }

  // 2. repeated_task — task patterns from session summaries (4+ repetitions)
  const summaryRes = await sessionsDb.execute({
    sql: `SELECT summary FROM sessions
          WHERE repo = ? AND status = 'complete' AND summary IS NOT NULL AND started_at >= ?
          ORDER BY ended_at DESC LIMIT 100`,
    args: [repo, cutoff],
  });
  const summaries = summaryRes.rows.map((r) =>
    String((r as Record<string, unknown>)["summary"] ?? ""),
  );

  if (summaries.length >= 4) {
    // Find common operation verbs in summaries
    const operationPatterns: Array<[RegExp, string]> = [
      [/\b(migrat\w+)\b/gi, "migration"],
      [/\b(refactor\w+)\b/gi, "refactor"],
      [/\b(debug\w+|fix\w+\sbug\w*)\b/gi, "debugging"],
      [/\b(deploy\w+)\b/gi, "deployment"],
      [/\b(test\w+)\b/gi, "testing"],
      [/\b(review\w+)\b/gi, "review"],
      [/\b(optimis\w+|optim[iz]\w+)\b/gi, "optimisation"],
      [/\b(document\w+|docs?\b)\b/gi, "documentation"],
    ];
    const patternCounts = new Map<string, number>();
    const patternSamples = new Map<string, string[]>();
    for (const summary of summaries) {
      for (const [pattern, label] of operationPatterns) {
        if (pattern.test(summary)) {
          patternCounts.set(label, (patternCounts.get(label) ?? 0) + 1);
          const existing = patternSamples.get(label) ?? [];
          if (existing.length < 5) existing.push(summary.slice(0, 80));
          patternSamples.set(label, existing);
          pattern.lastIndex = 0; // reset global regex
        }
      }
    }
    for (const [label, count] of patternCounts) {
      if (count >= 4) {
        suggestions.push({
          reason: "repeated_task",
          name: `${label}-guide`,
          description: `"${label}" has appeared in ${count} session summaries — a skill could standardise this workflow.`,
          evidence: patternSamples.get(label) ?? [],
          priority: count >= 8 ? "high" : "medium",
        });
      }
    }
  }

  // 3. deferred_cluster — 3+ deferred items sharing a topic keyword
  const deferredRes = await sessionsDb.execute({
    sql: `SELECT content FROM deferred_work
          WHERE repo = ? AND status = 'open'
          ORDER BY created_at DESC LIMIT 50`,
    args: [repo],
  });
  const deferredContents = deferredRes.rows.map((r) =>
    String((r as Record<string, unknown>)["content"] ?? ""),
  );

  if (deferredContents.length >= 3) {
    const keyword = topKeyword(deferredContents, 3);
    if (keyword) {
      const matching = deferredContents
        .filter((c) => c.toLowerCase().includes(keyword))
        .slice(0, 5);
      suggestions.push({
        reason: "deferred_cluster",
        name: `${keyword}-automation`,
        description: `${matching.length} deferred items share the keyword "${keyword}" — a skill could automate or guide this area.`,
        evidence: matching,
        priority: matching.length >= 5 ? "high" : "low",
      });
    }
  }

  // 4. missing_doc — symbols with confirmed decisions but no skill
  const confirmedSymRes = await sessionsDb.execute({
    sql: `SELECT DISTINCT symbol FROM decisions
          WHERE repo = ? AND symbol IS NOT NULL AND confidence = 'confirmed'`,
    args: [repo],
  });
  for (const row of confirmedSymRes.rows) {
    const sym = String((row as Record<string, unknown>)["symbol"]);
    const isCoveredConfirmed = Array.from(coveredSymbols).some((name) =>
      name.includes(sym.toLowerCase()) || sym.toLowerCase().includes(name),
    );
    if (!isCoveredConfirmed) {
      suggestions.push({
        reason: "missing_doc",
        name: `${sym}-conventions`,
        description: `\`${sym}\` has confirmed decisions but no skill documents its usage conventions.`,
        evidence: [],
        priority: "low",
      });
    }
  }

  // Deduplicate by name, keeping highest priority
  const seen = new Map<string, SkillSuggestion>();
  const priorityOrder: Record<string, number> = { high: 3, medium: 2, low: 1 };
  for (const s of suggestions) {
    const existing = seen.get(s.name);
    if (!existing || priorityOrder[s.priority]! > priorityOrder[existing.priority]!) {
      seen.set(s.name, s);
    }
  }

  return {
    repo,
    generated_at: now,
    sessions_analysed: sessionsAnalysed,
    suggestions: Array.from(seen.values()),
  };
}
