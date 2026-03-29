import type { EnrichedDepGraph, EnrichedFileNode } from "../deps.js";
import { basename } from "path";

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface DecisionNode {
  id: string;
  content: string;
  type: "decision" | "risk" | "deferred";
  confidence: string;
  symbol?: string;
  files: string[];  // files this record is associated with
}

/**
 * Render a decision propagation view — shows how a decision flows through the
 * import graph, highlighting affected files.
 *
 * `focusFile` is the file we start from; the view shows all downstream files
 * (files that import focusFile, transitively) and any reasoning records attached
 * to those files.
 */
export function renderPropagationView(
  graph: EnrichedDepGraph,
  focusFile: string,
  title: string,
): string {
  // Build a map of file → node
  const nodeMap = new Map<string, EnrichedFileNode>(
    graph.nodes.map((n) => [n.path, n]),
  );

  // BFS outward through dependents (files that import focusFile)
  const affected = new Set<string>([focusFile]);
  const queue = [focusFile];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const node = nodeMap.get(cur);
    if (!node) continue;
    for (const dep of node.dependents) {
      if (!affected.has(dep)) {
        affected.add(dep);
        queue.push(dep);
      }
    }
  }

  const affectedNodes = graph.nodes.filter((n) => affected.has(n.path));

  // Filter edges to only those within the affected set
  const affectedEdges = graph.edges.filter(
    (e) => affected.has(e.from) && affected.has(e.to),
  );

  const d3Nodes = affectedNodes.map((n) => ({
    id: n.path,
    label: basename(n.path),
    is_focus: n.path === focusFile,
    decision_count: n.decision_count,
    risk_count: n.risk_count,
    deferred_count: n.deferred_count,
    annotation_count: n.annotation_count,
    has_reasoning: n.has_reasoning,
    depth: n.depth,
  }));

  const d3Links = affectedEdges.map((e) => ({
    source: e.from,
    target: e.to,
    kind: e.kind,
  }));

  const dataJson = JSON.stringify({
    nodes: d3Nodes,
    links: d3Links,
    focus: focusFile,
    affected_count: affected.size,
  }).replace(/<\/script/gi, "<\\/script");

  const affectedCount = affected.size;
  const reasoningCount = affectedNodes.filter((n) => n.has_reasoning).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Decision Propagation — ${escHtml(basename(focusFile))}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#f1f5f9;display:flex;flex-direction:column;height:100vh;overflow:hidden}
#header{background:#1e293b;border-bottom:1px solid #334155;padding:10px 16px;display:flex;align-items:center;gap:12px;flex-shrink:0}
#header h1{font-size:14px;font-weight:600;flex:1}
#header .meta{font-size:11px;color:#64748b;white-space:nowrap}
#subheader{background:#1e293b;border-bottom:1px solid #334155;padding:7px 16px;display:flex;gap:16px;align-items:center;flex-shrink:0}
.focus-badge{background:#3b82f6;color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;font-family:monospace}
.count-badge{font-size:11px;color:#94a3b8}
#controls{background:#1e293b;border-bottom:1px solid #334155;padding:6px 14px;display:flex;gap:10px;flex-shrink:0}
#controls button{font-size:11px;padding:3px 8px;border:1px solid #475569;border-radius:4px;background:#334155;color:#e2e8f0;cursor:pointer}
#controls button:hover{background:#475569}
#main{display:flex;flex:1;overflow:hidden;position:relative}
#graph-container{flex:1;position:relative;overflow:hidden}
svg#graph{width:100%;height:100%;cursor:grab}
svg#graph:active{cursor:grabbing}
.node circle{stroke:#1e293b;stroke-width:1.5;transition:opacity 0.15s}
.node.dimmed circle{opacity:0.2}
.node.dimmed text{opacity:0.1}
.node.focus circle{stroke:#fbbf24;stroke-width:3}
.node.has-risk circle{stroke:#ef4444;stroke-width:2}
.node text{font-size:10px;pointer-events:none;fill:#cbd5e1;text-anchor:middle}
.link{stroke:#3b82f6;stroke-opacity:0.4}
.link.highlighted{stroke-opacity:0.9;stroke-width:2}
#panel{position:absolute;top:0;right:0;bottom:0;width:320px;background:#1e293b;border-left:1px solid #334155;overflow-y:auto;transform:translateX(100%);transition:transform 0.2s ease;z-index:10;box-shadow:-8px 0 24px rgba(0,0,0,0.4)}
#panel.open{transform:translateX(0)}
#panel-inner{padding:16px}
#panel-close{position:sticky;top:0;display:flex;justify-content:space-between;background:#1e293b;padding:4px 0 10px;border-bottom:1px solid #334155;margin-bottom:12px}
#panel-close h2{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#64748b}
#panel-close button{background:none;border:none;cursor:pointer;font-size:18px;color:#64748b;padding:2px 6px}
#panel-close button:hover{color:#f1f5f9}
.file-name{font-size:15px;font-weight:600;color:#f1f5f9;margin-bottom:4px;font-family:monospace}
.file-path{font-size:11px;color:#64748b;word-break:break-all;margin-bottom:10px;font-family:monospace}
.stat-row{display:flex;gap:8px;margin-bottom:12px}
.stat{background:#0f172a;border:1px solid #334155;border-radius:6px;padding:6px 10px;flex:1;text-align:center}
.stat-num{font-size:16px;font-weight:700;color:#f1f5f9}
.stat-num.red{color:#ef4444}
.stat-num.blue{color:#3b82f6}
.stat-label{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em}
.panel-empty{font-size:12px;color:#64748b;padding:20px 0;text-align:center}
.focus-note{font-size:12px;color:#fbbf24;background:#422006;padding:8px 10px;border-radius:6px;margin-bottom:12px}
</style>
</head>
<body>
<div id="header">
  <h1>Decision Propagation — ${escHtml(title)}</h1>
  <span class="meta">${affectedCount} affected files · ${reasoningCount} with reasoning</span>
</div>
<div id="subheader">
  <span>Focus:</span>
  <span class="focus-badge">${escHtml(focusFile)}</span>
  <span class="count-badge">Shows all files that (transitively) import this file</span>
</div>
<div id="controls">
  <button id="btn-reset">Reset zoom</button>
  <button id="btn-focus-only" class="sec">Focus only</button>
</div>
<div id="main">
  <div id="graph-container"><svg id="graph"></svg></div>
  <div id="panel">
    <div id="panel-inner">
      <div id="panel-close">
        <h2>File details</h2>
        <button id="close-btn">×</button>
      </div>
      <div id="panel-body"><p class="panel-empty">Click a node to inspect</p></div>
    </div>
  </div>
</div>
<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
const DATA = ${dataJson};

const svg = d3.select("#graph");
const g = svg.append("g");

const zoom = d3.zoom().scaleExtent([0.05, 4]).on("zoom", e => g.attr("transform", e.transform));
svg.call(zoom);

document.getElementById("btn-reset").onclick = () =>
  svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity);

let nodeEls, linkEls;
let showFocusOnly = false;

function buildSim(nodes, links) {
  if (window._sim) window._sim.stop();
  const w = document.getElementById("graph-container").clientWidth;
  const h = document.getElementById("graph-container").clientHeight;

  const sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(80).strength(0.6))
    .force("charge", d3.forceManyBody().strength(-150))
    .force("center", d3.forceCenter(w / 2, h / 2))
    .force("collision", d3.forceCollide(16));
  window._sim = sim;

  g.selectAll("*").remove();

  linkEls = g.append("g")
    .selectAll("line").data(links).join("line")
    .attr("class", "link").attr("stroke-width", 1.5);

  nodeEls = g.append("g")
    .selectAll("g").data(nodes).join("g")
    .attr("class", d => "node" + (d.is_focus ? " focus" : "") + (d.risk_count > 0 ? " has-risk" : ""))
    .call(d3.drag()
      .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
    )
    .on("click", (e, d) => { e.stopPropagation(); showPanel(d); });

  nodeEls.append("circle")
    .attr("r", d => d.is_focus ? 14 : (6 + Math.min(d.annotation_count, 3) * 2))
    .attr("fill", d => d.is_focus ? "#3b82f6" : (d.risk_count > 0 ? "#7f1d1d" : (d.has_reasoning ? "#1e3a5f" : "#1e293b")));

  nodeEls.append("text")
    .text(d => d.label.length > 14 ? d.label.slice(0, 12) + "…" : d.label)
    .attr("y", d => (d.is_focus ? 14 : 8) + 10)
    .attr("text-anchor", "middle");

  nodeEls.append("title").text(d =>
    d.id + "\\nDecisions: " + d.decision_count + " | Risks: " + d.risk_count
  );

  sim.on("tick", () => {
    linkEls
      .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    nodeEls.attr("transform", d => \`translate(\${d.x},\${d.y})\`);
  });

  svg.on("click", () => {
    document.getElementById("panel").classList.remove("open");
  });
}

function showPanel(d) {
  const body = document.getElementById("panel-body");
  body.innerHTML = \`
    \${d.is_focus ? '<div class="focus-note">Focus file — changes here propagate to all connected nodes</div>' : ""}
    <div class="file-name">\${d.label}</div>
    <div class="file-path">\${d.id}</div>
    <div class="stat-row">
      <div class="stat"><div class="stat-num red">\${d.risk_count}</div><div class="stat-label">Risks</div></div>
      <div class="stat"><div class="stat-num blue">\${d.decision_count}</div><div class="stat-label">Decisions</div></div>
      <div class="stat"><div class="stat-num">\${d.deferred_count}</div><div class="stat-label">Deferred</div></div>
    </div>
    \${!d.has_reasoning ? '<p class="panel-empty">No reasoning records for this file.</p>' : ""}
  \`;
  document.getElementById("panel").classList.add("open");
}

document.getElementById("close-btn").onclick = () =>
  document.getElementById("panel").classList.remove("open");

document.getElementById("btn-focus-only").onclick = () => {
  showFocusOnly = !showFocusOnly;
  const btn = document.getElementById("btn-focus-only");
  btn.textContent = showFocusOnly ? "Show all" : "Focus only";
  const nodes = showFocusOnly ? DATA.nodes.filter(n => n.is_focus || n.has_reasoning) : DATA.nodes;
  const nodeSet = new Set(nodes.map(n => n.id));
  const links = DATA.links.filter(l => nodeSet.has(l.source) && nodeSet.has(l.target));
  buildSim([...nodes], [...links]);
};

buildSim([...DATA.nodes], [...DATA.links]);
</script>
</body>
</html>`;
}
