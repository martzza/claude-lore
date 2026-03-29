import type { GraphData } from "../service.js";

const SHAPES: Record<string, string> = {
  decision: "box",
  risk:     "diamond",
  deferred: "ellipse",
  symbol:   "hexagon",
  repo:     "folder",
  session:  "oval",
};

const FILL_COLORS: Record<string, string> = {
  decision: "#dbeafe",
  risk:     "#fee2e2",
  deferred: "#fef3c7",
  symbol:   "#d1fae5",
  repo:     "#ede9fe",
  session:  "#f3f4f6",
};

const BORDER_COLORS: Record<string, string> = {
  decision: "#2563eb",
  risk:     "#dc2626",
  deferred: "#d97706",
  symbol:   "#059669",
  repo:     "#7c3aed",
  session:  "#6b7280",
};

const EDGE_STYLES: Record<string, string> = {
  constrains: "solid",
  enables:    "solid",
  supersedes: "dashed",
  calls:      "solid",
  defers:     "dotted",
  imports:    "dotted",
  risks:      "dashed",
  anchors:    "solid",
};

const EDGE_COLORS: Record<string, string> = {
  risks:      "#dc2626",
  supersedes: "#d97706",
  imports:    "#7c3aed",
};

function dotId(id: string): string {
  return `"${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function dotLabel(label: string, type: string): string {
  const safe = label.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").slice(0, 55);
  return `${safe}\\n(${type})`;
}

export function toDot(graph: GraphData): string {
  const title = graph.title.replace(/"/g, "'");
  const lines: string[] = [
    `digraph "${title}" {`,
    `  rankdir=TD;`,
    `  node [fontname="Helvetica", fontsize=11, margin="0.2,0.1"];`,
    `  edge [fontname="Helvetica", fontsize=9];`,
    `  label="${title}";`,
    `  labelloc=t;`,
    `  graph [bgcolor="#fafafa"];`,
    ``,
  ];

  for (const node of graph.nodes) {
    const shape = SHAPES[node.type] ?? "oval";
    const fill = FILL_COLORS[node.type] ?? "#f3f4f6";
    const border = BORDER_COLORS[node.type] ?? "#6b7280";
    const style = node.status === "orphaned" ? "dashed,filled" : "filled";
    const label = dotLabel(node.label, node.type);
    const width = (Math.min(node.weight, 8) / 4).toFixed(1);
    lines.push(
      `  ${dotId(node.id)} [label="${label}", shape=${shape}, style="${style}", fillcolor="${fill}", color="${border}", width=${width}];`,
    );
  }

  lines.push(``);

  for (const edge of graph.edges) {
    const style = EDGE_STYLES[edge.type] ?? "solid";
    const color = EDGE_COLORS[edge.type] ?? "#374151";
    const penwidth = Math.max(0.8, edge.weight / 4).toFixed(1);
    const attrs: string[] = [
      `style="${style}"`,
      `color="${color}"`,
      `penwidth=${penwidth}`,
    ];
    if (edge.label) attrs.push(`label="${edge.label}"`);
    lines.push(`  ${dotId(edge.from)} -> ${dotId(edge.to)} [${attrs.join(", ")}];`);
  }

  lines.push(`}`);
  return lines.join("\n");
}
