import type { EnrichedDepGraph, EnrichedFileNode } from "../deps.js";
import { basename, dirname } from "path";

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Assign a colour based on risk/decision counts
function nodeColour(node: EnrichedFileNode): string {
  if (node.risk_count > 0) return "#ef4444";      // red — has risks
  if (node.decision_count > 0) return "#3b82f6";  // blue — has decisions
  if (node.deferred_count > 0) return "#f59e0b";  // amber — has deferred
  return "#94a3b8";                                // grey — no reasoning
}

function nodeRadius(node: EnrichedFileNode): number {
  const base = 6;
  const bonus = Math.min(node.annotation_count * 2, 12);
  return base + bonus;
}

function groupLabel(node: EnrichedFileNode): string {
  const dir = dirname(node.path);
  return dir === "." ? "(root)" : dir.split("/").slice(0, 3).join("/");
}

export function renderCodebaseMap(
  graph: EnrichedDepGraph,
  title: string,
  layout: "force" | "hierarchy" | "radial" = "force",
): string {
  const nodeCount = graph.nodes.length;
  const edgeCount = graph.edges.length;

  // Build D3-ready node/link structures
  const d3Nodes = graph.nodes.map((n) => ({
    id: n.path,
    label: basename(n.path),
    group: groupLabel(n),
    depth: n.depth,
    colour: nodeColour(n),
    radius: nodeRadius(n),
    decision_count: n.decision_count,
    risk_count: n.risk_count,
    deferred_count: n.deferred_count,
    annotation_count: n.annotation_count,
    has_reasoning: n.has_reasoning,
    size_bytes: n.size_bytes,
    ext: n.ext,
    dep_count: n.deps.length,
    dependent_count: n.dependents.length,
    is_entry: graph.entry_points.includes(n.path),
    records: n.records,
    source_lines: n.source_lines,
  }));

  const d3Links = graph.edges.map((e) => ({
    source: e.from,
    target: e.to,
    kind: e.kind,
  }));

  const dataJson = JSON.stringify({ nodes: d3Nodes, links: d3Links, layout })
    .replace(/<\/script/gi, "<\\/script");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Codebase Map — ${escHtml(title)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#f1f5f9;display:flex;flex-direction:column;height:100vh;overflow:hidden}
#header{background:#1e293b;border-bottom:1px solid #334155;padding:10px 16px;display:flex;align-items:center;gap:12px;flex-shrink:0}
#header h1{font-size:14px;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#header .meta{font-size:11px;color:#64748b;white-space:nowrap}
#controls{background:#1e293b;border-bottom:1px solid #334155;padding:7px 14px;display:flex;align-items:center;gap:10px;flex-shrink:0;flex-wrap:wrap}
#controls label{font-size:12px;color:#94a3b8;display:flex;align-items:center;gap:5px}
#controls select,#controls button{font-size:11px;padding:3px 8px;border:1px solid #475569;border-radius:4px;background:#334155;color:#e2e8f0;cursor:pointer}
#controls button{background:#3b82f6;border-color:#3b82f6;color:#fff}
#controls button:hover{background:#2563eb}
#controls button.sec{background:#334155;border-color:#475569;color:#e2e8f0}
#controls button.sec:hover{background:#475569}
.legend{display:flex;gap:10px;margin-left:auto;align-items:center;flex-wrap:wrap}
.legend-item{display:flex;align-items:center;gap:4px;font-size:11px;color:#94a3b8}
.legend-dot{width:10px;height:10px;border-radius:50%}
#main{display:flex;flex:1;overflow:hidden;position:relative}
#graph-container{flex:1;position:relative;overflow:hidden}
svg#graph{width:100%;height:100%;cursor:grab}
svg#graph:active{cursor:grabbing}
.node circle{stroke:#1e293b;stroke-width:1.5;transition:opacity 0.15s,r 0.1s}
.node.dimmed circle{opacity:0.15}
.node.dimmed text{opacity:0.1}
.node.selected circle{stroke:#f1f5f9;stroke-width:2.5}
.node text{font-size:10px;pointer-events:none;fill:#cbd5e1}
.node.entry-point circle{stroke:#fbbf24;stroke-width:2}
.link{stroke:#334155;stroke-opacity:0.6;transition:opacity 0.15s}
.link.import{stroke:#3b82f6;stroke-opacity:0.4}
.link.require{stroke:#f59e0b;stroke-opacity:0.4}
.link.dynamic{stroke:#8b5cf6;stroke-opacity:0.4}
.link.dimmed{opacity:0.05}
.link.highlighted{stroke-opacity:0.9!important;stroke-width:2}
/* Panel */
#panel{position:absolute;top:0;right:0;bottom:0;width:520px;background:#1e293b;border-left:1px solid #334155;overflow-y:auto;transform:translateX(100%);transition:transform 0.2s ease;z-index:10;box-shadow:-8px 0 24px rgba(0,0,0,0.4)}
#panel.open{transform:translateX(0)}
@media(max-width:800px){#panel{width:100%}}
#panel-inner{padding:16px}
#panel-close{position:sticky;top:0;display:flex;justify-content:space-between;align-items:center;background:#1e293b;padding:4px 0 10px;border-bottom:1px solid #334155;margin-bottom:12px}
#panel-close h2{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#64748b}
#panel-close button{background:none;border:none;cursor:pointer;font-size:18px;color:#64748b;line-height:1;padding:2px 6px;border-radius:4px}
#panel-close button:hover{background:#334155;color:#f1f5f9}
.file-path{font-size:11px;color:#64748b;word-break:break-all;margin-bottom:12px;font-family:monospace}
.file-name{font-size:16px;font-weight:600;color:#f1f5f9;margin-bottom:4px;font-family:monospace}
.stat-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.stat{background:#0f172a;border:1px solid #334155;border-radius:6px;padding:6px 10px;text-align:center;flex:1;min-width:60px}
.stat-num{font-size:18px;font-weight:700;color:#f1f5f9}
.stat-num.red{color:#ef4444}
.stat-num.blue{color:#3b82f6}
.stat-num.amber{color:#f59e0b}
.stat-label{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em}
.section{margin-bottom:14px}
.section-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#64748b;margin-bottom:6px}
.file-list{list-style:none}
.file-list li{font-size:11px;font-family:monospace;color:#94a3b8;padding:2px 0;border-bottom:1px solid #1e293b;word-break:break-all}
.file-list li:hover{color:#f1f5f9;cursor:pointer}
.badge{display:inline-flex;align-items:center;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:600}
.badge-entry{background:#fef3c7;color:#92400e}
.panel-empty{font-size:12px;color:#64748b;padding:24px 0;text-align:center}
/* Tabs */
.tab-bar{display:flex;border-bottom:1px solid #334155;margin-bottom:12px;gap:0}
.tab-btn{background:none;border:none;border-bottom:2px solid transparent;color:#64748b;cursor:pointer;font-size:11px;font-weight:600;padding:6px 10px;text-transform:uppercase;letter-spacing:0.07em;transition:color 0.15s,border-color 0.15s}
.tab-btn:hover{color:#e2e8f0}
.tab-btn.active{color:#f1f5f9;border-bottom-color:#3b82f6}
.tab-content{display:none}
.tab-content.active{display:block}
/* Annotations */
.annotation{background:#0f172a;border:1px solid #334155;border-radius:6px;margin-bottom:8px;padding:8px 10px}
.annotation.ann-risk{border-left:3px solid #ef4444}
.annotation.ann-decision{border-left:3px solid #3b82f6}
.annotation.ann-deferred{border-left:3px solid #f59e0b}
.ann-header{display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap}
.ann-type{font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px}
.ann-decision .ann-type{background:#1e3a5f;color:#93c5fd}
.ann-risk .ann-type{background:#450a0a;color:#fca5a5}
.ann-deferred .ann-type{background:#422006;color:#fde68a}
.ann-conf{font-size:9px;padding:1px 5px;border-radius:3px}
.conf-confirmed{background:#d1fae5;color:#065f46}
.conf-extracted{background:#fef3c7;color:#92400e}
.conf-inferred{background:#f3f4f6;color:#374151}
.conf-contested{background:#fce7f3;color:#9d174d}
.ann-symbol{font-size:10px;font-family:monospace;color:#94a3b8;background:#1e293b;padding:1px 5px;border-radius:3px}
.ann-content{font-size:12px;color:#cbd5e1;line-height:1.55;white-space:pre-wrap;word-break:break-word}
/* Code viewer */
.code-viewer{overflow:auto;max-height:420px;border:1px solid #334155;border-radius:4px;background:#0a0f1a}
.code-table{width:100%;border-collapse:collapse;font-family:"Cascadia Code","Fira Code",monospace;font-size:10.5px;line-height:1.5}
.code-table td{padding:0 6px;vertical-align:top;white-space:pre}
.line-num{color:#475569;text-align:right;user-select:none;min-width:32px;border-right:1px solid #1e293b;padding-right:8px}
.line-code{color:#94a3b8;word-break:break-all}
.code-line:hover{background:#1e293b}
.code-line.code-hl-risk{background:#2a0909}
.code-line.code-hl-risk .line-code{color:#fca5a5}
.code-line.code-hl-risk .line-num{color:#ef4444}
.code-line.code-hl-decision{background:#091a2a}
.code-line.code-hl-decision .line-code{color:#93c5fd}
.code-line.code-hl-decision .line-num{color:#3b82f6}
.code-line.code-hl-deferred{background:#2a1a05}
.code-line.code-hl-deferred .line-code{color:#fde68a}
.code-line.code-hl-deferred .line-num{color:#f59e0b}
.code-truncated{font-size:10px;color:#64748b;padding:6px 10px;text-align:center;border-top:1px solid #334155}
</style>
</head>
<body>
<div id="header">
  <h1>Codebase Map — ${escHtml(title)}</h1>
  <span class="meta">${nodeCount} files · ${edgeCount} edges</span>
</div>
<div id="controls">
  <label>Layout
    <select id="layout-select">
      <option value="force" ${layout === "force" ? "selected" : ""}>Force</option>
      <option value="radial" ${layout === "radial" ? "selected" : ""}>Radial</option>
    </select>
  </label>
  <label>Filter
    <select id="filter-select">
      <option value="all">All files</option>
      <option value="reasoning">Has reasoning</option>
      <option value="risks">Has risks</option>
      <option value="entry">Entry points</option>
    </select>
  </label>
  <button id="btn-reset" class="sec">Reset zoom</button>
  <div class="legend">
    <div class="legend-item"><div class="legend-dot" style="background:#ef4444"></div>Risk</div>
    <div class="legend-item"><div class="legend-dot" style="background:#3b82f6"></div>Decision</div>
    <div class="legend-item"><div class="legend-dot" style="background:#f59e0b"></div>Deferred</div>
    <div class="legend-item"><div class="legend-dot" style="background:#94a3b8"></div>No reasoning</div>
  </div>
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
const container = svg.append("g");

// Zoom
const zoom = d3.zoom()
  .scaleExtent([0.05, 4])
  .on("zoom", (e) => container.attr("transform", e.transform));
svg.call(zoom);

document.getElementById("btn-reset").onclick = () => {
  svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity);
};

let allNodes = DATA.nodes;
let allLinks = DATA.links;

// Build simulation
let sim;
let nodeEls, linkEls;
let activeFilter = "all";
let selectedId = null;

function buildSim(nodes, links) {
  if (sim) sim.stop();

  const width = document.getElementById("graph-container").clientWidth;
  const height = document.getElementById("graph-container").clientHeight;
  const cx = width / 2, cy = height / 2;

  // Build id → index map
  const nodeById = new Map(nodes.map((n, i) => [n.id, i]));

  // Safe links (filter out broken refs)
  const safeLinks = links.filter(l => nodeById.has(l.source) || nodeById.has(typeof l.source === "object" ? l.source.id : l.source));

  sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(safeLinks).id(d => d.id).distance(60).strength(0.5))
    .force("charge", d3.forceManyBody().strength(-120))
    .force("center", d3.forceCenter(cx, cy))
    .force("collision", d3.forceCollide(d => d.radius + 4));

  container.selectAll("*").remove();

  // Draw links
  linkEls = container.append("g").attr("class", "links")
    .selectAll("line")
    .data(safeLinks)
    .join("line")
    .attr("class", d => "link " + d.kind)
    .attr("stroke-width", 1);

  // Draw nodes
  nodeEls = container.append("g").attr("class", "nodes")
    .selectAll("g")
    .data(nodes)
    .join("g")
    .attr("class", d => "node" + (d.is_entry ? " entry-point" : ""))
    .call(d3.drag()
      .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
    )
    .on("click", (e, d) => { e.stopPropagation(); selectNode(d); });

  nodeEls.append("circle")
    .attr("r", d => d.radius)
    .attr("fill", d => d.colour);

  nodeEls.append("text")
    .text(d => d.label.length > 16 ? d.label.slice(0, 14) + "…" : d.label)
    .attr("y", d => d.radius + 9)
    .attr("text-anchor", "middle");

  // Tooltip
  nodeEls.append("title").text(d =>
    d.id + "\\n" +
    "Decisions: " + d.decision_count + " | Risks: " + d.risk_count + " | Deferred: " + d.deferred_count + "\\n" +
    "Imports: " + d.dep_count + " | Imported by: " + d.dependent_count
  );

  sim.on("tick", () => {
    linkEls
      .attr("x1", d => d.source.x)
      .attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x)
      .attr("y2", d => d.target.y);
    nodeEls.attr("transform", d => \`translate(\${d.x},\${d.y})\`);
  });

  svg.on("click", () => deselectNode());
}

function filteredData() {
  let nodes = allNodes;
  if (activeFilter === "reasoning") nodes = nodes.filter(n => n.has_reasoning);
  else if (activeFilter === "risks") nodes = nodes.filter(n => n.risk_count > 0);
  else if (activeFilter === "entry") nodes = nodes.filter(n => n.is_entry);

  const nodeSet = new Set(nodes.map(n => n.id));
  const links = allLinks.filter(l => nodeSet.has(l.source) && nodeSet.has(l.target));
  return { nodes, links };
}

function selectNode(d) {
  selectedId = d.id;
  highlightNode(d.id);
  showPanel(d);
}

function deselectNode() {
  selectedId = null;
  if (nodeEls) {
    nodeEls.classed("dimmed", false).classed("selected", false);
    linkEls.classed("dimmed", false).classed("highlighted", false);
  }
  document.getElementById("panel").classList.remove("open");
}

function highlightNode(id) {
  if (!nodeEls) return;
  const connectedLinks = allLinks.filter(l => {
    const s = typeof l.source === "object" ? l.source.id : l.source;
    const t = typeof l.target === "object" ? l.target.id : l.target;
    return s === id || t === id;
  });
  const connected = new Set([id]);
  connectedLinks.forEach(l => {
    const s = typeof l.source === "object" ? l.source.id : l.source;
    const t = typeof l.target === "object" ? l.target.id : l.target;
    connected.add(s);
    connected.add(t);
  });

  nodeEls
    .classed("dimmed", d => !connected.has(d.id))
    .classed("selected", d => d.id === id);
  linkEls
    .classed("dimmed", l => {
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      return s !== id && t !== id;
    })
    .classed("highlighted", l => {
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      return s === id || t === id;
    });
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildAnnotationsHtml(records) {
  if (!records || records.length === 0) {
    return '<p class="panel-empty">No reasoning records for this file</p>';
  }
  return records.map(r => {
    const typeLabel = r.type === 'decision' ? 'DECISION' : r.type === 'risk' ? 'RISK' : 'DEFERRED';
    const typeClass = r.type === 'decision' ? 'ann-decision' : r.type === 'risk' ? 'ann-risk' : 'ann-deferred';
    const confClass = 'conf-' + (r.confidence || 'extracted');
    return \`<div class="annotation \${typeClass}">
      <div class="ann-header">
        <span class="ann-type">\${typeLabel}</span>
        <span class="ann-conf \${confClass}">\${escHtml(r.confidence || 'extracted')}</span>
        \${r.symbol ? \`<span class="ann-symbol">\${escHtml(r.symbol)}</span>\` : ''}
      </div>
      <div class="ann-content">\${escHtml(r.content)}</div>
    </div>\`;
  }).join('');
}

function buildCodeHtml(sourceLines, records) {
  if (!sourceLines || sourceLines.length === 0) {
    return '<p class="panel-empty">Source not available</p>';
  }
  // Group symbols by record type for colour-coded highlighting
  const riskSymbols = (records || []).filter(r => r.type === 'risk').map(r => r.symbol).filter(Boolean);
  const decisionSymbols = (records || []).filter(r => r.type === 'decision').map(r => r.symbol).filter(Boolean);
  const deferredSymbols = (records || []).filter(r => r.type === 'deferred').map(r => r.symbol).filter(Boolean);
  const rows = sourceLines.map((line, i) => {
    let hlClass = '';
    if (riskSymbols.length > 0 && riskSymbols.some(sym => line.includes(sym))) hlClass = ' code-hl-risk';
    else if (decisionSymbols.length > 0 && decisionSymbols.some(sym => line.includes(sym))) hlClass = ' code-hl-decision';
    else if (deferredSymbols.length > 0 && deferredSymbols.some(sym => line.includes(sym))) hlClass = ' code-hl-deferred';
    return \`<tr class="code-line\${hlClass}">
      <td class="line-num">\${i + 1}</td>
      <td class="line-code">\${escHtml(line)}</td>
    </tr>\`;
  }).join('');
  const truncNote = sourceLines.length >= 100
    ? '<div class="code-truncated">Showing first 100 lines</div>' : '';
  return \`<div class="code-viewer"><table class="code-table"><tbody>\${rows}</tbody></table>\${truncNote}</div>\`;
}

function buildDepsHtml(imports, importedBy) {
  const importsHtml = imports.length > 0
    ? \`<div class="section"><div class="section-label">Imports (\${imports.length})</div>
       <ul class="file-list">\${imports.slice(0, 15).map(f => \`<li onclick="selectNodeById('\${f}')">\${f}</li>\`).join('')}
       \${imports.length > 15 ? \`<li style="color:#64748b">… \${imports.length - 15} more</li>\` : ''}</ul></div>\` : '';
  const importedByHtml = importedBy.length > 0
    ? \`<div class="section"><div class="section-label">Imported by (\${importedBy.length})</div>
       <ul class="file-list">\${importedBy.slice(0, 15).map(f => \`<li onclick="selectNodeById('\${f}')">\${f}</li>\`).join('')}
       \${importedBy.length > 15 ? \`<li style="color:#64748b">… \${importedBy.length - 15} more</li>\` : ''}</ul></div>\` : '';
  return (importsHtml + importedByHtml) || '<p class="panel-empty">No import relationships</p>';
}

let activeTab = 'annotations';

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.dataset.tab === tab));
}

function showPanel(d) {
  const panel = document.getElementById("panel");
  const body = document.getElementById("panel-body");

  const imports = allLinks.filter(l => {
    const s = typeof l.source === "object" ? l.source.id : l.source;
    return s === d.id;
  }).map(l => typeof l.target === "object" ? l.target.id : l.target);

  const importedBy = allLinks.filter(l => {
    const t = typeof l.target === "object" ? l.target.id : l.target;
    return t === d.id;
  }).map(l => typeof l.source === "object" ? l.source.id : l.source);

  const riskClass = d.risk_count > 0 ? "red" : "";
  const decClass = d.decision_count > 0 ? "blue" : "";
  const defClass = d.deferred_count > 0 ? "amber" : "";

  // Default to annotations tab when node has records, otherwise code
  const defaultTab = (d.records && d.records.length > 0) ? 'annotations' : 'code';
  activeTab = defaultTab;

  body.innerHTML = \`
    <div class="file-name">\${escHtml(d.label)}</div>
    <div class="file-path">\${escHtml(d.id)}</div>
    \${d.is_entry ? '<span class="badge badge-entry">Entry point</span><br><br>' : ""}
    <div class="stat-row">
      <div class="stat"><div class="stat-num \${riskClass}">\${d.risk_count}</div><div class="stat-label">Risks</div></div>
      <div class="stat"><div class="stat-num \${decClass}">\${d.decision_count}</div><div class="stat-label">Decisions</div></div>
      <div class="stat"><div class="stat-num \${defClass}">\${d.deferred_count}</div><div class="stat-label">Deferred</div></div>
      <div class="stat"><div class="stat-num">\${(d.size_bytes / 1024).toFixed(1)}k</div><div class="stat-label">Size</div></div>
    </div>
    <div class="tab-bar">
      <button class="tab-btn\${defaultTab === 'annotations' ? ' active' : ''}" data-tab="annotations">Annotations\${d.annotation_count > 0 ? ' (' + d.annotation_count + ')' : ''}</button>
      <button class="tab-btn\${defaultTab === 'code' ? ' active' : ''}" data-tab="code">Code</button>
      <button class="tab-btn" data-tab="deps">Deps (\${imports.length + importedBy.length})</button>
    </div>
    <div class="tab-content\${defaultTab === 'annotations' ? ' active' : ''}" data-tab="annotations">
      \${buildAnnotationsHtml(d.records)}
    </div>
    <div class="tab-content\${defaultTab === 'code' ? ' active' : ''}" data-tab="code">
      \${buildCodeHtml(d.source_lines, d.records)}
    </div>
    <div class="tab-content" data-tab="deps">
      \${buildDepsHtml(imports, importedBy)}
    </div>
  \`;

  body.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  panel.classList.add("open");
}

window.selectNodeById = function(id) {
  const d = allNodes.find(n => n.id === id);
  if (d) selectNode(d);
};

document.getElementById("close-btn").onclick = deselectNode;
document.getElementById("filter-select").onchange = (e) => {
  activeFilter = e.target.value;
  const { nodes, links } = filteredData();
  buildSim(nodes, links);
};
document.getElementById("layout-select").onchange = (e) => {
  buildSim(...Object.values(filteredData()));
};

// Initial build
const { nodes: initNodes, links: initLinks } = filteredData();
buildSim(initNodes, initLinks);
</script>
</body>
</html>`;
}
