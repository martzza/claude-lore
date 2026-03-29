import type { GraphData } from "../service.js";

const MAX_NODES = 50;

function safeId(id: string): string {
  return "n" + id.replace(/[^a-zA-Z0-9]/g, "_");
}

function safeLabel(label: string): string {
  return label
    .replace(/"/g, "'")
    .replace(/[\n\r]/g, " ")
    .replace(/[<>{}[\]]/g, " ")
    .slice(0, 48);
}

const TYPE_CLASS: Record<string, string> = {
  decision: "decision",
  risk:     "risk",
  deferred: "deferred",
  symbol:   "symbol",
  repo:     "repo",
  session:  "session",
};

export function toMermaid(
  graph: GraphData,
  direction: "TD" | "LR" = "TD",
): string {
  const lines: string[] = [`flowchart ${direction}`];

  // Class definitions
  lines.push(
    `  classDef decision fill:#dbeafe,stroke:#2563eb,color:#1e3a5f`,
    `  classDef risk     fill:#fee2e2,stroke:#dc2626,color:#7f1d1d`,
    `  classDef deferred fill:#fef3c7,stroke:#d97706,color:#78350f`,
    `  classDef symbol   fill:#d1fae5,stroke:#059669,color:#064e3b`,
    `  classDef repo     fill:#ede9fe,stroke:#7c3aed,color:#3b0764`,
    `  classDef session  fill:#f3f4f6,stroke:#6b7280,color:#111827`,
    `  classDef orphaned fill:#f3f4f6,stroke:#9ca3af,stroke-dasharray:5 5`,
    ``,
  );

  // Trim to highest-weight nodes
  let activeNodes = graph.nodes;
  let trimmed = 0;
  if (activeNodes.length > MAX_NODES) {
    activeNodes = [...activeNodes].sort((a, b) => b.weight - a.weight).slice(0, MAX_NODES);
    trimmed = graph.nodes.length - MAX_NODES;
  }
  const activeIds = new Set(activeNodes.map((n) => n.id));

  // Node declarations
  for (const node of activeNodes) {
    const nid = safeId(node.id);
    const label = safeLabel(node.label);
    lines.push(`  ${nid}["${label}\\n(${node.type})"]`);
  }
  lines.push(``);

  // Class assignments
  for (const node of activeNodes) {
    const nid = safeId(node.id);
    const cls =
      node.status === "orphaned"
        ? "orphaned"
        : (TYPE_CLASS[node.type] ?? "session");
    lines.push(`  class ${nid} ${cls}`);
  }
  lines.push(``);

  // Edges (only between active nodes)
  const activeEdges = graph.edges.filter(
    (e) => activeIds.has(e.from) && activeIds.has(e.to),
  );
  for (const edge of activeEdges) {
    const from = safeId(edge.from);
    const to = safeId(edge.to);
    const lbl = edge.label ? `|${edge.label}|` : "";
    // Dashed for weak edges (weight < 5 or supersedes/imports)
    const isDashed =
      edge.weight < 5 ||
      edge.type === "imports" ||
      edge.type === "supersedes";
    const arrow = isDashed ? `-.->` : `-->`;
    lines.push(`  ${from} ${arrow}${lbl} ${to}`);
  }

  // Trim note
  if (trimmed > 0) {
    lines.push(``);
    lines.push(`  omitted["${trimmed} nodes omitted — use format=json for full data"]:::session`);
  }

  // Legend
  lines.push(``);
  lines.push(`  subgraph legend["Legend"]`);
  lines.push(`    L1["decision"]:::decision`);
  lines.push(`    L2["risk"]:::risk`);
  lines.push(`    L3["deferred"]:::deferred`);
  lines.push(`    L4["symbol"]:::symbol`);
  lines.push(`    L5["repo"]:::repo`);
  lines.push(`  end`);

  return lines.join("\n");
}
