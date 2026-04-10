import type { Client } from "@libsql/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SymbolRiskScore {
  symbol:       string;
  file:         string;
  total_score:  number;         // 0-100
  risk_level:   "low" | "medium" | "high" | "critical";
  components: {
    structural_centrality: number;  // 0-40
    reasoning_risk:        number;  // 0-30
    test_coverage:         number;  // 0-15
    community_impact:      number;  // 0-15
  };
  detail: {
    direct_callers:       number;
    transitive_callers:   number;
    high_risk_records:    number;
    critical_records:     number;
    has_test_coverage:    boolean;
    communities_affected: string[];
  };
}

export type Verdict = "low" | "medium" | "high" | "critical";

// ---------------------------------------------------------------------------
// Single-symbol scorer
// ---------------------------------------------------------------------------

export async function calculateChangeRisk(
  symbol:   string,
  _repo:    string,
  structDb: Client,
  reasonDb: Client,
): Promise<SymbolRiskScore> {

  // ── Structural centrality (0-40) ─────────────────────────────────────────

  const directRes = await structDb.execute({
    sql:  `SELECT COUNT(*) as c FROM call_graph WHERE callee = ? AND kind = 'calls'`,
    args: [symbol],
  });
  const directCount = Number(directRes.rows[0]?.["c"] ?? 0);

  const callers1Res = await structDb.execute({
    sql:  `SELECT DISTINCT caller FROM call_graph WHERE callee = ? AND kind = 'calls'`,
    args: [symbol],
  });
  const callerNames = callers1Res.rows.map((r) => String(r["caller"]));

  let transitiveCount = directCount;
  if (callerNames.length > 0) {
    const placeholders = callerNames.map(() => "?").join(",");
    const callers2Res = await structDb.execute({
      sql:  `SELECT COUNT(DISTINCT caller) as c FROM call_graph
             WHERE callee IN (${placeholders}) AND kind = 'calls'`,
      args: callerNames,
    });
    transitiveCount += Number(callers2Res.rows[0]?.["c"] ?? 0);
  }

  const centralityScore = Math.min(40, Math.round(Math.log2(transitiveCount + 1) * 8));

  // ── Reasoning risk (0-30) ────────────────────────────────────────────────
  // Uses confidence as severity proxy + keyword scan for CRITICAL/HIGH in content

  const risksRes = await reasonDb.execute({
    sql:  `SELECT confidence, content FROM risks
           WHERE symbol = ? AND lifecycle_status = 'active'`,
    args: [symbol],
  });

  let reasoningScore = 0;
  let highCount      = 0;
  let criticalCount  = 0;

  for (const row of risksRes.rows) {
    const confidence = String(row["confidence"] ?? "extracted");
    const content    = String(row["content"]    ?? "").toLowerCase();

    const hasCritical = content.includes("critical") || content.includes("a01") || content.includes("a02");
    const hasHigh     = content.includes("high") || content.includes("injection") || content.includes("pii");

    if (hasCritical || confidence === "confirmed") {
      reasoningScore += 15;
      criticalCount++;
    } else if (hasHigh) {
      reasoningScore += 8;
      highCount++;
    } else {
      reasoningScore += 3;
    }
  }
  reasoningScore = Math.min(30, reasoningScore);

  // ── Test coverage (0-15) ─────────────────────────────────────────────────

  const testRes = await structDb.execute({
    sql:  `SELECT COUNT(*) as c FROM call_graph WHERE callee = ? AND kind = 'test_covers'`,
    args: [symbol],
  });
  const hasTests      = Number(testRes.rows[0]?.["c"] ?? 0) > 0;
  const coverageScore = hasTests ? 0 : 15;

  // ── Community impact (0-15) ──────────────────────────────────────────────

  const communityImpactRes = await structDb.execute({
    sql:  `SELECT DISTINCT s.community
           FROM call_graph cg
           JOIN symbols s ON s.name = cg.caller
           WHERE cg.callee = ? AND cg.kind = 'calls'
           AND s.community IS NOT NULL`,
    args: [symbol],
  });

  const affectedCommunities = communityImpactRes.rows
    .map((r) => String(r["community"]))
    .filter(Boolean);

  const ownSymRes = await structDb.execute({
    sql:  `SELECT community FROM symbols WHERE name = ? LIMIT 1`,
    args: [symbol],
  });
  const ownCommunity = ownSymRes.rows[0]?.["community"]
    ? String(ownSymRes.rows[0]["community"]) : null;

  const crossCommunityCount = ownCommunity
    ? affectedCommunities.filter((c) => c !== ownCommunity).length
    : affectedCommunities.length;

  const communityScore = Math.min(15, crossCommunityCount * 5);

  // ── Total ────────────────────────────────────────────────────────────────

  const totalScore = centralityScore + reasoningScore + coverageScore + communityScore;

  const riskLevel: SymbolRiskScore["risk_level"] =
    totalScore >= 70 ? "critical" :
    totalScore >= 45 ? "high"     :
    totalScore >= 20 ? "medium"   : "low";

  const fileRes = await structDb.execute({
    sql:  `SELECT file FROM symbols WHERE name = ? LIMIT 1`,
    args: [symbol],
  });

  return {
    symbol,
    file:        fileRes.rows[0]?.["file"] ? String(fileRes.rows[0]["file"]) : "unknown",
    total_score: totalScore,
    risk_level:  riskLevel,
    components: {
      structural_centrality: centralityScore,
      reasoning_risk:        reasoningScore,
      test_coverage:         coverageScore,
      community_impact:      communityScore,
    },
    detail: {
      direct_callers:       directCount,
      transitive_callers:   transitiveCount,
      high_risk_records:    highCount,
      critical_records:     criticalCount,
      has_test_coverage:    hasTests,
      communities_affected: affectedCommunities,
    },
  };
}

// ---------------------------------------------------------------------------
// Score multiple symbols — returns ranked list, skips missing symbols silently
// ---------------------------------------------------------------------------

export async function scoreChangedSymbols(
  symbols:  string[],
  repo:     string,
  structDb: Client,
  reasonDb: Client,
): Promise<SymbolRiskScore[]> {
  const scores: SymbolRiskScore[] = [];

  for (const sym of symbols) {
    try {
      const score = await calculateChangeRisk(sym, repo, structDb, reasonDb);
      scores.push(score);
    } catch { /* skip unknown symbols */ }
  }

  return scores.sort((a, b) => b.total_score - a.total_score);
}

// ---------------------------------------------------------------------------
// Derive overall verdict from a set of scores
// ---------------------------------------------------------------------------

export function deriveVerdict(scores: SymbolRiskScore[]): Verdict {
  if (scores.some((s) => s.total_score >= 70)) return "critical";
  if (scores.some((s) => s.total_score >= 45)) return "high";
  if (scores.some((s) => s.total_score >= 20)) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Extract changed symbols from structural DB for a set of changed file paths
// ---------------------------------------------------------------------------

export async function getChangedSymbols(
  changedFilePaths: string[],
  structDb: Client,
): Promise<string[]> {
  if (changedFilePaths.length === 0) return [];

  const results: string[] = [];
  for (const filePath of changedFilePaths) {
    // Normalize to relative path (structural DB stores relative paths)
    const relPath = filePath.replace(/^\//, "");
    const res = await structDb.execute({
      sql:  `SELECT DISTINCT name FROM symbols WHERE file = ? AND is_test = 0 ORDER BY start_line`,
      args: [relPath],
    });
    results.push(...res.rows.map((r) => String(r["name"])));
  }

  // Deduplicate preserving order
  return [...new Set(results)];
}
