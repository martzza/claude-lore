import { sessionsDb, registryDb } from "../sqlite/db.js";
import { existsSync } from "fs";
import { join } from "path";
import { createClient } from "@libsql/client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  label: string;
  type: "decision" | "risk" | "deferred" | "symbol" | "repo" | "session";
  metadata: Record<string, unknown>;
  weight: number;
  status: "confirmed" | "extracted" | "inferred" | "orphaned" | "healthy";
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  type:
    | "constrains"
    | "enables"
    | "supersedes"
    | "calls"
    | "defers"
    | "imports"
    | "risks"
    | "anchors";
  weight: number;
}

export interface GraphData {
  title: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: {
    repo: string;
    generated: number;
    node_count: number;
    edge_count: number;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "to", "of", "in", "for",
  "on", "with", "that", "this", "it", "be", "or", "and", "not", "we",
  "by", "as", "at", "so", "if", "use", "used", "using", "from", "into",
  "have", "has", "which", "when", "will", "all", "one", "can", "its",
  "also", "each", "they", "their", "than", "then", "been",
]);

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w)),
  );
}

function keywordOverlap(a: string, b: string): number {
  const ka = keywords(a);
  const kb = keywords(b);
  let count = 0;
  for (const w of ka) if (kb.has(w)) count++;
  return count;
}

function confidenceWeight(conf: string): number {
  switch (conf) {
    case "confirmed": return 8;
    case "extracted": return 5;
    case "inferred":  return 3;
    default:          return 1;
  }
}

function nodeStatus(conf: string, anchorStatus: string): GraphNode["status"] {
  if (anchorStatus === "orphaned") return "orphaned";
  switch (conf) {
    case "confirmed": return "confirmed";
    case "extracted": return "extracted";
    case "inferred":  return "inferred";
    default:          return "healthy";
  }
}

function riskWeight(content: string): number {
  const lower = content.toLowerCase();
  if (lower.includes("[critical]")) return 10;
  if (lower.includes("[high]"))     return 8;
  if (lower.includes("[medium]"))   return 5;
  return 3;
}

function shortLabel(text: string, max = 45): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = `${e.from}|${e.to}|${e.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type Row = Record<string, unknown>;

// ─── buildDecisionHierarchy ───────────────────────────────────────────────────

export async function buildDecisionHierarchy(repo: string): Promise<GraphData> {
  const [decRes, riskRes, defRes] = await Promise.all([
    sessionsDb.execute({
      sql: `SELECT id, symbol, content, rationale, confidence, anchor_status, adr_status
            FROM decisions WHERE repo = ?`,
      args: [repo],
    }),
    sessionsDb.execute({
      sql: `SELECT id, symbol, content, confidence, anchor_status FROM risks WHERE repo = ?`,
      args: [repo],
    }),
    sessionsDb.execute({
      sql: `SELECT id, symbol, content, confidence, anchor_status, blocked_by
            FROM deferred_work WHERE repo = ? AND status = 'open'`,
      args: [repo],
    }),
  ]);

  const decisions = decRes.rows as Row[];
  const risks = riskRes.rows as Row[];
  const deferred = defRes.rows as Row[];

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Decision nodes
  for (const d of decisions) {
    const conf = String(d["confidence"] ?? "inferred");
    const content = String(d["content"] ?? "decision");
    nodes.push({
      id: String(d["id"]),
      label: shortLabel(content),
      type: "decision",
      metadata: {
        content,
        symbol: d["symbol"] ?? null,
        rationale: d["rationale"] ?? null,
        confidence: conf,
        adr_status: d["adr_status"] ?? null,
      },
      weight: confidenceWeight(conf),
      status: nodeStatus(conf, String(d["anchor_status"] ?? "healthy")),
    });
  }

  // Risk nodes
  for (const r of risks) {
    const conf = String(r["confidence"] ?? "inferred");
    const content = String(r["content"] ?? "risk");
    nodes.push({
      id: String(r["id"]),
      label: shortLabel(content),
      type: "risk",
      metadata: { content, symbol: r["symbol"] ?? null, confidence: conf },
      weight: riskWeight(content),
      status: nodeStatus(conf, String(r["anchor_status"] ?? "healthy")),
    });
  }

  // Deferred nodes
  for (const d of deferred) {
    const conf = String(d["confidence"] ?? "inferred");
    const content = String(d["content"] ?? "deferred");
    nodes.push({
      id: String(d["id"]),
      label: shortLabel(content),
      type: "deferred",
      metadata: {
        content,
        symbol: d["symbol"] ?? null,
        confidence: conf,
        blocked_by: d["blocked_by"] ?? null,
      },
      weight: confidenceWeight(conf),
      status: nodeStatus(conf, String(d["anchor_status"] ?? "healthy")),
    });
  }

  // Edges: decision → risk "risks"
  for (const dec of decisions) {
    const ds = dec["symbol"] as string | null;
    const dc = String(dec["content"] ?? "");
    for (const risk of risks) {
      const rs = risk["symbol"] as string | null;
      const rc = String(risk["content"] ?? "");
      if (ds && rs && ds === rs) {
        edges.push({ from: String(dec["id"]), to: String(risk["id"]), label: "risks", type: "risks", weight: 8 });
      } else if (keywordOverlap(dc, rc) >= 2) {
        edges.push({ from: String(dec["id"]), to: String(risk["id"]), label: "risks", type: "risks", weight: 4 });
      }
    }
  }

  // Edges: decision → decision "constrains" / "supersedes"
  for (let i = 0; i < decisions.length; i++) {
    for (let j = i + 1; j < decisions.length; j++) {
      const a = decisions[i]!;
      const b = decisions[j]!;
      const as_ = a["symbol"] as string | null;
      const bs = b["symbol"] as string | null;
      const ac = String(a["content"] ?? "");
      const bc = String(b["content"] ?? "") + " " + String(b["rationale"] ?? "");

      if (String(b["adr_status"]) === "superseded" && as_ && bs && as_ === bs) {
        edges.push({ from: String(a["id"]), to: String(b["id"]), label: "supersedes", type: "supersedes", weight: 10 });
      } else if (as_ && bs && as_ === bs && as_ !== "") {
        edges.push({ from: String(a["id"]), to: String(b["id"]), label: "constrains", type: "constrains", weight: 6 });
      } else if (keywordOverlap(ac, bc) >= 2) {
        edges.push({ from: String(a["id"]), to: String(b["id"]), label: "constrains", type: "constrains", weight: 3 });
      }
    }
  }

  // Edges: decision → deferred "defers"
  for (const dec of decisions) {
    const ds = dec["symbol"] as string | null;
    const dc = String(dec["content"] ?? "");
    for (const def of deferred) {
      const defs = def["symbol"] as string | null;
      const defc = String(def["content"] ?? "");
      if (ds && defs && ds === defs) {
        edges.push({ from: String(dec["id"]), to: String(def["id"]), label: "defers", type: "defers", weight: 6 });
      } else if (keywordOverlap(dc, defc) >= 2) {
        edges.push({ from: String(dec["id"]), to: String(def["id"]), label: "defers", type: "defers", weight: 4 });
      }
    }
  }

  // Edges: deferred → deferred "blocks" chain via blocked_by
  for (const b of deferred) {
    const blockedBy = b["blocked_by"] as string | null;
    if (!blockedBy) continue;
    const blocker = deferred.find(
      (a) =>
        String(a["id"]) === blockedBy ||
        String(a["content"] ?? "").slice(0, 30) === blockedBy.slice(0, 30),
    );
    if (blocker && String(blocker["id"]) !== String(b["id"])) {
      edges.push({ from: String(blocker["id"]), to: String(b["id"]), label: "blocks", type: "defers", weight: 10 });
    }
  }

  const dedupedEdges = dedupeEdges(edges);

  return {
    title: `Decision hierarchy — ${repo.split("/").pop() ?? repo}`,
    nodes,
    edges: dedupedEdges,
    meta: { repo, generated: Date.now(), node_count: nodes.length, edge_count: dedupedEdges.length },
  };
}

// ─── buildSymbolImpactGraph ───────────────────────────────────────────────────

export async function buildSymbolImpactGraph(
  symbol: string,
  repo: string,
): Promise<GraphData> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const centerId = `sym:${symbol}`;
  nodes.push({
    id: centerId,
    label: symbol,
    type: "symbol",
    metadata: { repo },
    weight: 10,
    status: "healthy",
  });

  // Try to enrich with structural call graph data
  const structuralPath = join(repo, ".codegraph", "structural.db");
  if (existsSync(structuralPath)) {
    try {
      const structDb = createClient({ url: "file:" + structuralPath });

      const callersRes = await structDb.execute({
        sql: `SELECT DISTINCT caller, caller_file, weight FROM call_graph WHERE callee = ? LIMIT 20`,
        args: [symbol],
      });

      const calleesRes = await structDb.execute({
        sql: `SELECT DISTINCT callee, callee_file, weight FROM call_graph WHERE caller = ? LIMIT 20`,
        args: [symbol],
      });

      for (const r of callersRes.rows as Row[]) {
        const caller = String(r["caller"]);
        const nodeId = `caller:${caller}`;
        if (!nodes.find((n) => n.id === nodeId)) {
          nodes.push({
            id: nodeId,
            label: caller,
            type: "symbol",
            metadata: { file: r["caller_file"] ?? null, kind: "caller", weight: r["weight"] ?? 1 },
            weight: Math.min(10, Number(r["weight"] ?? 1) * 2),
            status: "healthy",
          });
          edges.push({ from: centerId, to: nodeId, label: "called by", type: "calls", weight: Number(r["weight"] ?? 1) });
        }
      }

      for (const r of calleesRes.rows as Row[]) {
        const callee = String(r["callee"]);
        const nodeId = `callee:${callee}`;
        if (!nodes.find((n) => n.id === nodeId)) {
          nodes.push({
            id: nodeId,
            label: callee,
            type: "symbol",
            metadata: { file: r["callee_file"] ?? null, kind: "callee", weight: r["weight"] ?? 1 },
            weight: Math.min(10, Number(r["weight"] ?? 1) * 2),
            status: "healthy",
          });
          edges.push({ from: nodeId, to: centerId, label: "calls", type: "calls", weight: Number(r["weight"] ?? 1) });
        }
      }
    } catch { /* structural.db may be corrupt or schema version mismatch — silently skip */ }
  }

  const [decRes, riskRes, defRes, crossRes] = await Promise.all([
    sessionsDb.execute({
      sql: `SELECT id, content, confidence, anchor_status FROM decisions WHERE repo = ? AND symbol = ?`,
      args: [repo, symbol],
    }),
    sessionsDb.execute({
      sql: `SELECT id, content, confidence, anchor_status FROM risks WHERE repo = ? AND symbol = ?`,
      args: [repo, symbol],
    }),
    sessionsDb.execute({
      sql: `SELECT id, content, confidence, anchor_status FROM deferred_work
            WHERE repo = ? AND symbol = ? AND status = 'open'`,
      args: [repo, symbol],
    }),
    registryDb.execute({
      sql: `SELECT DISTINCT repo, tier FROM cross_repo_index
            WHERE (symbol = ? OR symbol LIKE ?) AND repo != ?
            ORDER BY indexed_at DESC LIMIT 10`,
      args: [symbol, `${symbol}.%`, repo],
    }),
  ]);

  for (const r of decRes.rows as Row[]) {
    const conf = String(r["confidence"] ?? "inferred");
    const content = String(r["content"] ?? "decision");
    nodes.push({
      id: String(r["id"]),
      label: shortLabel(content),
      type: "decision",
      metadata: { content, symbol, confidence: conf },
      weight: confidenceWeight(conf),
      status: nodeStatus(conf, String(r["anchor_status"] ?? "healthy")),
    });
    edges.push({ from: centerId, to: String(r["id"]), label: "anchors", type: "anchors", weight: 6 });
  }

  for (const r of riskRes.rows as Row[]) {
    const conf = String(r["confidence"] ?? "inferred");
    const content = String(r["content"] ?? "risk");
    const w = riskWeight(content);
    nodes.push({
      id: String(r["id"]),
      label: shortLabel(content),
      type: "risk",
      metadata: { content, symbol, confidence: conf },
      weight: w,
      status: nodeStatus(conf, String(r["anchor_status"] ?? "healthy")),
    });
    edges.push({ from: centerId, to: String(r["id"]), label: "risks", type: "risks", weight: w });
  }

  for (const r of defRes.rows as Row[]) {
    const conf = String(r["confidence"] ?? "inferred");
    const content = String(r["content"] ?? "deferred");
    nodes.push({
      id: String(r["id"]),
      label: shortLabel(content),
      type: "deferred",
      metadata: { content, symbol, confidence: conf },
      weight: confidenceWeight(conf),
      status: nodeStatus(conf, String(r["anchor_status"] ?? "healthy")),
    });
    edges.push({ from: centerId, to: String(r["id"]), label: "defers", type: "defers", weight: 5 });
  }

  const seenRepos = new Set<string>();
  for (const r of crossRes.rows as Row[]) {
    const consumerRepo = String(r["repo"]);
    if (seenRepos.has(consumerRepo)) continue;
    seenRepos.add(consumerRepo);
    const repoId = `repo:${consumerRepo}`;
    nodes.push({
      id: repoId,
      label: consumerRepo.split("/").pop() ?? consumerRepo,
      type: "repo",
      metadata: { path: consumerRepo, tier: r["tier"] },
      weight: 5,
      status: "healthy",
    });
    edges.push({ from: centerId, to: repoId, label: "imports", type: "imports", weight: 5 });
  }

  return {
    title: `Symbol impact — ${symbol}`,
    nodes,
    edges,
    meta: { repo, generated: Date.now(), node_count: nodes.length, edge_count: edges.length },
  };
}

// ─── buildPortfolioGraph ──────────────────────────────────────────────────────

export async function buildPortfolioGraph(repos?: string[]): Promise<GraphData> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const allManifests =
    repos && repos.length > 0
      ? await registryDb.execute({
          sql: `SELECT repo, manifest, synced_at FROM repo_manifests
                WHERE repo IN (${repos.map(() => "?").join(",")})`,
          args: repos,
        })
      : await registryDb.execute({
          sql: `SELECT repo, manifest, synced_at FROM repo_manifests ORDER BY synced_at DESC`,
          args: [],
        });

  for (const row of allManifests.rows as Row[]) {
    const repoPath = String(row["repo"]);
    let manifest: Record<string, unknown[]> = {};
    try {
      manifest = JSON.parse(String(row["manifest"])) as Record<string, unknown[]>;
    } catch (err) {
      console.warn(`[graph] Failed to parse manifest for repo ${repoPath}:`, String(err));
    }

    const symbolCount = [
      ...((manifest["exported_decisions"] ?? []) as Row[]),
      ...((manifest["exported_deferred"] ?? []) as Row[]),
      ...((manifest["exported_risks"] ?? []) as Row[]),
    ].filter((r) => r["symbol"]).length;

    nodes.push({
      id: repoPath,
      label: repoPath.split("/").pop() ?? repoPath,
      type: "repo",
      metadata: { path: repoPath, exported_symbols: symbolCount, synced_at: row["synced_at"] },
      weight: Math.min(10, Math.max(1, symbolCount)),
      status: "healthy",
    });
  }

  const crossRes = await registryDb.execute({
    sql: `SELECT symbol, repo, tier FROM cross_repo_index ORDER BY indexed_at DESC`,
    args: [],
  });

  // Count shared symbols between repo pairs
  const pairWeights = new Map<string, { count: number; symbols: string[] }>();
  const seenBySymbol = new Map<string, string[]>();

  for (const row of crossRes.rows as Row[]) {
    const sym = String(row["symbol"]);
    const repoPath = String(row["repo"]);
    if (!seenBySymbol.has(sym)) seenBySymbol.set(sym, []);
    seenBySymbol.get(sym)!.push(repoPath);
  }

  for (const [sym, repoPaths] of seenBySymbol) {
    const unique = [...new Set(repoPaths)];
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const a = unique[i]!;
        const b = unique[j]!;
        const key = [a, b].sort().join("|||");
        const existing = pairWeights.get(key) ?? { count: 0, symbols: [] };
        existing.count++;
        existing.symbols.push(sym);
        pairWeights.set(key, existing);
      }
    }
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const [key, { count, symbols }] of pairWeights) {
    const [repoA, repoB] = key.split("|||") as [string, string];
    if (!nodeIds.has(repoA) || !nodeIds.has(repoB)) continue;
    edges.push({
      from: repoA,
      to: repoB,
      label: symbols.slice(0, 3).join(", "),
      type: "imports",
      weight: Math.min(10, count),
    });
  }

  return {
    title: "Portfolio dependency graph",
    nodes,
    edges,
    meta: {
      repo: repos?.join(", ") ?? "all",
      generated: Date.now(),
      node_count: nodes.length,
      edge_count: edges.length,
    },
  };
}
