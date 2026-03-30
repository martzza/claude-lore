import { sessionsDb, registryDb } from "../sqlite/db.js";

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

export async function buildDecisionHierarchy(repo: string, service?: string): Promise<GraphData> {
  const svcClause = service !== undefined ? "AND service IS ?" : "";
  const baseArgs = (extra: unknown[] = []): (string | null)[] =>
    service !== undefined ? [repo, service ?? null, ...extra as (string | null)[]] : [repo, ...extra as (string | null)[]];

  const [decRes, riskRes, defRes] = await Promise.all([
    sessionsDb.execute({
      sql: `SELECT id, symbol, content, rationale, confidence, anchor_status, adr_status
            FROM decisions WHERE repo = ? ${svcClause}`,
      args: baseArgs(),
    }),
    sessionsDb.execute({
      sql: `SELECT id, symbol, content, confidence, anchor_status FROM risks WHERE repo = ? ${svcClause}`,
      args: baseArgs(),
    }),
    sessionsDb.execute({
      sql: `SELECT id, symbol, content, confidence, anchor_status, blocked_by
            FROM deferred_work WHERE repo = ? ${svcClause} AND status = 'open'`,
      args: baseArgs(),
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

  const repoLabel = repo.split("/").pop() ?? repo;
  const title = service ? `Decision hierarchy — ${repoLabel} / ${service}` : `Decision hierarchy — ${repoLabel}`;

  return {
    title,
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
    } catch {}

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

// ─── buildServiceGraph ────────────────────────────────────────────────────────
//
// Intra-repo service dependency graph. Nodes are services (packages) within a
// single monorepo. Edges are drawn when two services share a symbol anchor OR
// when a record in one service mentions another service's name in its content.
//
// This gives agents a map of which services are coupled so they can reason about
// blast radius within the monorepo before making cross-service changes.

export interface ServiceGraphMeta {
  repo: string;
  services_found: number;
  generated: number;
  node_count: number;
  edge_count: number;
}

export interface ServiceGraphData extends Omit<GraphData, "meta"> {
  meta: ServiceGraphMeta;
}

export async function buildServiceGraph(repo: string): Promise<ServiceGraphData> {
  // Step 1: load all records that have a service label in this repo
  const [decRes, riskRes, defRes] = await Promise.all([
    sessionsDb.execute({
      sql: `SELECT service, symbol, content FROM decisions
            WHERE repo = ? AND service IS NOT NULL`,
      args: [repo],
    }),
    sessionsDb.execute({
      sql: `SELECT service, symbol, content FROM risks
            WHERE repo = ? AND service IS NOT NULL`,
      args: [repo],
    }),
    sessionsDb.execute({
      sql: `SELECT service, symbol, content FROM deferred_work
            WHERE repo = ? AND service IS NOT NULL AND status = 'open'`,
      args: [repo],
    }),
  ]);

  type ServiceRow = { service: string; symbol: string | null; content: string };
  const allRows: ServiceRow[] = [
    ...(decRes.rows as Row[]).map((r) => ({
      service: String(r["service"]),
      symbol: r["symbol"] != null ? String(r["symbol"]) : null,
      content: String(r["content"] ?? ""),
    })),
    ...(riskRes.rows as Row[]).map((r) => ({
      service: String(r["service"]),
      symbol: r["symbol"] != null ? String(r["symbol"]) : null,
      content: String(r["content"] ?? ""),
    })),
    ...(defRes.rows as Row[]).map((r) => ({
      service: String(r["service"]),
      symbol: r["symbol"] != null ? String(r["symbol"]) : null,
      content: String(r["content"] ?? ""),
    })),
  ];

  if (allRows.length === 0) {
    return {
      title: `Service dependency graph — ${repo.split("/").pop() ?? repo}`,
      nodes: [],
      edges: [],
      meta: { repo, services_found: 0, generated: Date.now(), node_count: 0, edge_count: 0 },
    };
  }

  // Step 2: collect per-service stats
  const serviceStats = new Map<string, { decisions: number; risks: number; deferred: number }>();
  for (const r of decRes.rows as Row[]) {
    const svc = String(r["service"]);
    const s = serviceStats.get(svc) ?? { decisions: 0, risks: 0, deferred: 0 };
    s.decisions++;
    serviceStats.set(svc, s);
  }
  for (const r of riskRes.rows as Row[]) {
    const svc = String(r["service"]);
    const s = serviceStats.get(svc) ?? { decisions: 0, risks: 0, deferred: 0 };
    s.risks++;
    serviceStats.set(svc, s);
  }
  for (const r of defRes.rows as Row[]) {
    const svc = String(r["service"]);
    const s = serviceStats.get(svc) ?? { decisions: 0, risks: 0, deferred: 0 };
    s.deferred++;
    serviceStats.set(svc, s);
  }

  const services = Array.from(serviceStats.keys());

  // Step 3: build nodes — one per service
  const nodes: GraphNode[] = services.map((svc) => {
    const stats = serviceStats.get(svc)!;
    const total = stats.decisions + stats.risks + stats.deferred;
    return {
      id: `svc:${svc}`,
      label: svc,
      type: "repo" as const, // re-use "repo" type for rendering purposes
      metadata: {
        service: svc,
        decisions: stats.decisions,
        risks: stats.risks,
        deferred: stats.deferred,
        total_records: total,
      },
      weight: Math.min(10, Math.max(1, total)),
      status: "healthy" as const,
    };
  });

  // Step 4: build edges
  // 4a. Shared symbols — two services that both have records anchored to the same symbol
  const symbolToServices = new Map<string, Set<string>>();
  for (const row of allRows) {
    if (!row.symbol) continue;
    if (!symbolToServices.has(row.symbol)) symbolToServices.set(row.symbol, new Set());
    symbolToServices.get(row.symbol)!.add(row.service);
  }

  const edgeWeights = new Map<string, { weight: number; labels: string[] }>();
  const addEdge = (a: string, b: string, label: string, w: number) => {
    const key = [a, b].sort().join("|||");
    const existing = edgeWeights.get(key) ?? { weight: 0, labels: [] };
    existing.weight += w;
    if (!existing.labels.includes(label)) existing.labels.push(label);
    edgeWeights.set(key, existing);
  };

  for (const [sym, svcs] of symbolToServices) {
    const svcList = Array.from(svcs);
    for (let i = 0; i < svcList.length; i++) {
      for (let j = i + 1; j < svcList.length; j++) {
        addEdge(svcList[i]!, svcList[j]!, sym, 3);
      }
    }
  }

  // 4b. Content mentions — service A's record content mentions service B's name
  for (const row of allRows) {
    const content = row.content.toLowerCase();
    for (const otherSvc of services) {
      if (otherSvc === row.service) continue;
      // Match on the short service name (last path segment, without scope prefix)
      const shortName = otherSvc.replace(/^@[^/]+\//, "").split("/").pop()!.toLowerCase();
      if (shortName.length < 3) continue; // skip very short names that cause false positives
      if (content.includes(shortName)) {
        addEdge(row.service, otherSvc, `mentions ${shortName}`, 1);
      }
    }
  }

  const edges: GraphEdge[] = [];
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const [key, { weight, labels }] of edgeWeights) {
    const [a, b] = key.split("|||") as [string, string];
    const fromId = `svc:${a}`;
    const toId = `svc:${b}`;
    if (!nodeIds.has(fromId) || !nodeIds.has(toId)) continue;
    edges.push({
      from: fromId,
      to: toId,
      label: labels.slice(0, 3).join(", "),
      type: "imports" as const,
      weight: Math.min(10, weight),
    });
  }

  return {
    title: `Service dependency graph — ${repo.split("/").pop() ?? repo}`,
    nodes,
    edges,
    meta: {
      repo,
      services_found: services.length,
      generated: Date.now(),
      node_count: nodes.length,
      edge_count: edges.length,
    },
  };
}
