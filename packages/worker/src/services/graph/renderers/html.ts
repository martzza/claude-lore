import type { GraphData } from "../service.js";

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function toHtml(graph: GraphData): string {
  const dataJson = JSON.stringify(graph).replace(/<\/script/gi, "<\\/script");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escHtml(graph.title)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f8fafc;display:flex;flex-direction:column;height:100vh;overflow:hidden}
#header{background:#1e293b;color:#f1f5f9;padding:10px 16px;display:flex;align-items:center;gap:12px;flex-shrink:0}
#header h1{font-size:14px;font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#header .meta{font-size:11px;color:#94a3b8;white-space:nowrap}
#controls{background:#fff;border-bottom:1px solid #e2e8f0;padding:8px 14px;display:flex;align-items:center;gap:10px;flex-shrink:0;flex-wrap:wrap}
#controls label{font-size:12px;color:#374151;display:flex;align-items:center;gap:5px}
#controls select,#controls button{font-size:12px;padding:3px 8px;border:1px solid #d1d5db;border-radius:4px;background:#fff;cursor:pointer}
#controls button{background:#2563eb;color:#fff;border-color:#2563eb}
#controls button:hover{background:#1d4ed8}
#controls button.secondary{background:#fff;color:#374151;border-color:#d1d5db}
#controls button.secondary:hover{background:#f9fafb}
#main{display:flex;flex:1;overflow:hidden;position:relative}
#graph-container{flex:1;position:relative;overflow:hidden}
svg#graph{width:100%;height:100%;cursor:grab}
svg#graph:active{cursor:grabbing}
.node circle{stroke-width:2;transition:opacity 0.15s}
.node text{font-size:11px;pointer-events:none;text-anchor:middle;dominant-baseline:middle}
.node.dimmed circle{opacity:0.2}
.node.dimmed text{opacity:0.2}
.link{transition:opacity 0.15s}
.link.dimmed{opacity:0.1}
.link-label{font-size:9px;fill:#6b7280;pointer-events:none}

/* ── Panel ── */
#panel{
  position:absolute;top:0;right:0;bottom:0;
  width:320px;
  background:#fff;
  border-left:1px solid #e2e8f0;
  overflow-y:auto;
  transform:translateX(100%);
  transition:transform 0.2s ease;
  z-index:10;
  box-shadow:-4px 0 16px rgba(0,0,0,0.08);
}
#panel.open{transform:translateX(0)}
@media(max-width:600px){#panel{width:100%}}
#panel-inner{padding:16px}
#panel-close{
  position:sticky;top:0;
  display:flex;justify-content:flex-end;
  background:#fff;
  padding:4px 0 8px;
  margin-bottom:4px;
}
#panel-close button{
  background:none;border:none;cursor:pointer;
  font-size:18px;color:#9ca3af;line-height:1;padding:2px 6px;border-radius:4px;
}
#panel-close button:hover{background:#f3f4f6;color:#374151}
.panel-empty{font-size:12px;color:#9ca3af;padding:20px 0;text-align:center}

/* Card layout */
.card-icon-row{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.card-icon{font-size:20px;line-height:1}
.card-type{font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;flex:1}
.card-badge{
  display:inline-flex;align-items:center;
  padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;
  white-space:nowrap;
}
.badge-confirmed{background:#d1fae5;color:#065f46}
.badge-extracted{background:#fef3c7;color:#92400e}
.badge-inferred{background:#f3f4f6;color:#374151}
.badge-contested{background:#fee2e2;color:#991b1b}
.badge-orphaned{background:#f3f4f6;color:#9ca3af}
.sev-critical{background:#fef2f2;color:#991b1b;border:1px solid #fca5a5}
.sev-high{background:#fff7ed;color:#c2410c;border:1px solid #fdba74}
.sev-medium{background:#fefce8;color:#a16207;border:1px solid #fde047}
.sev-low{background:#eff6ff;color:#1d4ed8;border:1px solid #93c5fd}
.card-title{font-size:15px;font-weight:600;color:#111827;line-height:1.4;margin-bottom:14px}
.card-section{margin-bottom:12px}
.card-section-label{
  font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;
  color:#9ca3af;margin-bottom:4px;
}
.card-section-body{font-size:13px;color:#374151;line-height:1.55;word-break:break-word}
.card-section-body ul{padding-left:1.2em}
.card-section-body li{margin-bottom:3px}
.card-meta-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:14px;padding-top:12px;border-top:1px solid #f3f4f6}
.card-meta-item{font-size:11px;color:#6b7280}
.card-meta-item span{color:#111827;font-weight:500}
.show-more{font-size:11px;color:#2563eb;cursor:pointer;margin-top:4px;display:inline-block}
.show-more:hover{text-decoration:underline}
.text-full{display:none}

/* Tooltip */
#tooltip{
  position:fixed;
  background:#1e293b;color:#f1f5f9;
  font-size:11px;line-height:1.4;
  padding:6px 10px;border-radius:6px;
  pointer-events:none;
  white-space:nowrap;
  max-width:280px;
  white-space:normal;
  z-index:20;
  opacity:0;transition:opacity 0.1s;
  box-shadow:0 4px 12px rgba(0,0,0,0.2);
}
#tooltip.visible{opacity:1}

/* Legend */
#legend{position:absolute;bottom:12px;left:12px;background:rgba(255,255,255,0.92);border:1px solid #e2e8f0;border-radius:6px;padding:8px 12px;font-size:11px;pointer-events:none}
#legend h4{font-size:10px;font-weight:600;color:#6b7280;text-transform:uppercase;margin-bottom:6px}
.legend-item{display:flex;align-items:center;gap:6px;margin-bottom:3px}
.legend-dot{width:10px;height:10px;border-radius:50%;border:2px solid}
</style>
</head>
<body>
<div id="header">
  <h1>${escHtml(graph.title)}</h1>
  <span class="meta" id="meta-label"></span>
</div>
<div id="controls">
  <button onclick="resetZoom()">Reset view</button>
  <button class="secondary" onclick="exportSvg()">Export SVG</button>
  <label>Type:
    <select id="filter-type" onchange="applyFilters()">
      <option value="all">All types</option>
      <option value="decision">Decisions</option>
      <option value="risk">Risks</option>
      <option value="deferred">Deferred</option>
      <option value="symbol">Symbols</option>
      <option value="repo">Repos</option>
    </select>
  </label>
  <label>Confidence:
    <select id="filter-conf" onchange="applyFilters()">
      <option value="all">All confidence</option>
      <option value="confirmed">Confirmed</option>
      <option value="extracted">Extracted</option>
      <option value="inferred">Inferred</option>
    </select>
  </label>
</div>
<div id="main">
  <div id="graph-container">
    <svg id="graph"></svg>
    <div id="legend">
      <h4>Legend</h4>
      <div class="legend-item"><div class="legend-dot" style="background:#dbeafe;border-color:#2563eb"></div>Decision</div>
      <div class="legend-item"><div class="legend-dot" style="background:#fee2e2;border-color:#dc2626"></div>Risk</div>
      <div class="legend-item"><div class="legend-dot" style="background:#fef3c7;border-color:#d97706"></div>Deferred</div>
      <div class="legend-item"><div class="legend-dot" style="background:#d1fae5;border-color:#059669"></div>Symbol</div>
      <div class="legend-item"><div class="legend-dot" style="background:#ede9fe;border-color:#7c3aed"></div>Repo</div>
    </div>
  </div>
  <div id="panel">
    <div id="panel-inner">
      <div id="panel-close"><button onclick="closePanel()" title="Close">×</button></div>
      <div id="panel-body"><div class="panel-empty">Click a node to see details</div></div>
    </div>
  </div>
</div>
<div id="tooltip"></div>

<script type="application/json" id="graph-data">${dataJson}</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>
<script>
const graphData = JSON.parse(document.getElementById('graph-data').textContent);

const TYPE_FILL   = {decision:'#dbeafe',risk:'#fee2e2',deferred:'#fef3c7',symbol:'#d1fae5',repo:'#ede9fe',session:'#f3f4f6'};
const TYPE_STROKE = {decision:'#2563eb',risk:'#dc2626',deferred:'#d97706',symbol:'#059669',repo:'#7c3aed',session:'#6b7280'};
const TYPE_ICON   = {decision:'📋',risk:'⚠',deferred:'⏸',symbol:'◆',repo:'🗂',session:'⏱'};
const TYPE_LABEL  = {decision:'DECISION',risk:'RISK',deferred:'DEFERRED',symbol:'SYMBOL',repo:'REPOSITORY',session:'SESSION'};

document.getElementById('meta-label').textContent =
  graphData.nodes.length + ' nodes · ' + graphData.edges.length + ' edges';

const svg = d3.select('#graph');
const container = document.getElementById('graph-container');
const tooltip   = document.getElementById('tooltip');
const panel     = document.getElementById('panel');

function getSize(){ return {w:container.clientWidth, h:container.clientHeight}; }

const g = svg.append('g').attr('id','zoom-group');

const defs = svg.append('defs');
['normal','risk','import'].forEach(id=>{
  defs.append('marker')
    .attr('id','arrow-'+id).attr('viewBox','0 -5 10 10')
    .attr('refX',20).attr('refY',0).attr('markerWidth',6).attr('markerHeight',6)
    .attr('orient','auto')
    .append('path').attr('d','M0,-5L10,0L0,5')
    .attr('fill', id==='risk'?'#dc2626':id==='import'?'#7c3aed':'#94a3b8');
});

const adjacency = new Map();
graphData.nodes.forEach(n=>adjacency.set(n.id, new Set()));
graphData.edges.forEach(e=>{
  if(adjacency.has(e.from)) adjacency.get(e.from).add(e.to);
  if(adjacency.has(e.to))   adjacency.get(e.to).add(e.from);
});

// Build adjacency counts for symbol nodes
const neighborCount = new Map();
graphData.nodes.forEach(n=>neighborCount.set(n.id,0));
graphData.edges.forEach(e=>{
  neighborCount.set(e.from,(neighborCount.get(e.from)||0)+1);
  neighborCount.set(e.to,  (neighborCount.get(e.to)  ||0)+1);
});

let {w,h} = getSize();

const linkData = graphData.edges.map(e=>({...e,source:e.from,target:e.to}));

const linkForce = d3.forceLink(linkData)
  .id(d=>d.id)
  .distance(d=>100+(10-(d.weight||5))*8);

const sim = d3.forceSimulation(graphData.nodes.map(n=>({...n})))
  .force('link', linkForce)
  .force('charge', d3.forceManyBody().strength(-350))
  .force('center', d3.forceCenter(w/2,h/2))
  .force('collide', d3.forceCollide().radius(d=>nodeRadius(d)+12));

function nodeRadius(d){ return Math.max(8,d.weight*4); }

const link = g.append('g').attr('class','links')
  .selectAll('g').data(linkData).join('g').attr('class','link');

link.append('line')
  .attr('stroke', d=>d.type==='risks'?'#dc2626':d.type==='imports'?'#7c3aed':'#94a3b8')
  .attr('stroke-width', d=>Math.max(0.8,(d.weight||5)/4))
  .attr('stroke-dasharray', d=>(d.weight<5||d.type==='imports'||d.type==='supersedes')?'4,3':null)
  .attr('marker-end', d=>'url(#arrow-'+(d.type==='risks'?'risk':d.type==='imports'?'import':'normal')+')');

link.append('text').attr('class','link-label')
  .text(d=>(d.label||'').slice(0,12)).attr('dy',-3);

const node = g.append('g').attr('class','nodes')
  .selectAll('g').data(sim.nodes()).join('g').attr('class','node')
  .call(d3.drag()
    .on('start',(event,d)=>{ if(!event.active) sim.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
    .on('drag', (event,d)=>{ d.fx=event.x; d.fy=event.y; })
    .on('end',  (event,d)=>{ if(!event.active) sim.alphaTarget(0); d.fx=null; d.fy=null; }))
  .on('click',     (event,d)=>{ event.stopPropagation(); selectNode(d); })
  .on('mousemove', (event,d)=>showTooltip(event,d))
  .on('mouseout',  ()=>{ hideTooltip(); clearHighlight(); });

node.append('circle')
  .attr('r', d=>nodeRadius(d))
  .attr('fill', d=>d.status==='orphaned'?'#f3f4f6':(TYPE_FILL[d.type]||'#f3f4f6'))
  .attr('stroke', d=>d.status==='orphaned'?'#9ca3af':(TYPE_STROKE[d.type]||'#6b7280'))
  .attr('stroke-width', d=>d.status==='confirmed'?3:2)
  .attr('stroke-dasharray', d=>d.status==='orphaned'?'4,2':null);

node.append('text')
  .attr('dy', d=>nodeRadius(d)+12)
  .text(d=>d.label.slice(0,22)+(d.label.length>22?'…':''));

svg.on('click', ()=>closePanel());

sim.on('tick',()=>{
  link.select('line')
    .attr('x1',d=>d.source.x).attr('y1',d=>d.source.y)
    .attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
  link.select('text')
    .attr('x',d=>(d.source.x+d.target.x)/2)
    .attr('y',d=>(d.source.y+d.target.y)/2);
  node.attr('transform',d=>'translate('+d.x+','+d.y+')');
});

const zoom = d3.zoom().scaleExtent([0.1,8]).on('zoom',e=>g.attr('transform',e.transform));
svg.call(zoom);

function resetZoom(){
  svg.transition().duration(500).call(zoom.transform,d3.zoomIdentity.translate(w/2,h/2).scale(0.8));
}

// ── Tooltip ──────────────────────────────────────────────────────────────

function showTooltip(event, d){
  const meta = d.metadata||{};
  const conf = meta.confidence||d.status||'';
  const sev  = d.type==='risk'?(d.label.match(/^\\[(.*?)\\]/)||[])[1]||'':'';
  let text = (TYPE_ICON[d.type]||'') + ' ' + d.label.slice(0,60)+(d.label.length>60?'…':'');
  if(conf||sev) text += '\\n' + [conf,sev?sev.toUpperCase():null].filter(Boolean).join(' · ');
  tooltip.style.whiteSpace = 'pre';
  tooltip.textContent = text;
  tooltip.classList.add('visible');
  positionTooltip(event);
  highlightNode(d);
}

function hideTooltip(){
  tooltip.classList.remove('visible');
}

function positionTooltip(event){
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  let x = event.clientX+14, y = event.clientY-10;
  if(x+tw > window.innerWidth-8) x = event.clientX-tw-14;
  if(y+th > window.innerHeight-8) y = event.clientY-th-10;
  tooltip.style.left = x+'px';
  tooltip.style.top  = y+'px';
}

// ── Panel helpers ─────────────────────────────────────────────────────────

function e(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function badgeConf(conf){
  const cls = {confirmed:'badge-confirmed',extracted:'badge-extracted',inferred:'badge-inferred',contested:'badge-contested',orphaned:'badge-orphaned'}[conf]||'badge-inferred';
  return '<span class="card-badge '+cls+'">'+e(conf)+'</span>';
}

function badgeSev(sev){
  if(!sev) return '';
  const cls = {critical:'sev-critical',high:'sev-high',medium:'sev-medium',low:'sev-low'}[sev.toLowerCase()]||'sev-medium';
  return '<span class="card-badge '+cls+'">'+e(sev.toUpperCase())+'</span>';
}

// Extract a short human title from raw content:
// - strips confidence prefixes ("session records suggest: ...")
// - strips [SEVERITY] prefixes ("[CRITICAL] ...")
// - takes the first sentence / first 80 chars
function smartTitle(raw){
  if(!raw) return '';
  let s = String(raw);
  s = s.replace(/^(session records suggest:|inferred from documentation:|conflicting records exist:)\s*/i,'');
  s = s.replace(/^\[(?:critical|high|medium|low)\]\s*/i,'');
  // first sentence
  const dot = s.search(/[.!?\\n—]/);
  if(dot>0&&dot<80) s = s.slice(0,dot);
  return s.trim().slice(0,120);
}

// Extract severity from raw content string
function parseSev(raw){
  const m = String(raw||'').match(/^\[(critical|high|medium|low)\]/i);
  return m?m[1].toLowerCase():'';
}

function formatSource(source){
  if(!source) return null;
  if(source.startsWith('template:')) return source.replace('template:','').replace(/-/g,' ')+' template';
  if(source.startsWith('md:'))       return source.replace(/^md:/,'').split(':')[0];
  if(source.startsWith('git-log:'))  return 'git history';
  if(source==='session')             return 'captured in session';
  return source;
}

function section(label, body){
  if(!body) return '';
  return '<div class="card-section"><div class="card-section-label">'+label+'</div><div class="card-section-body">'+body+'</div></div>';
}

function truncated(text, maxLen){
  if(!text||text.length<=maxLen) return e(text||'');
  const short = e(text.slice(0,maxLen));
  const full  = e(text);
  return '<span class="text-short">'+short+'… <span class="show-more" onclick="toggleMore(this)">show more</span></span>'
       + '<span class="text-full">'+full+' <span class="show-more" onclick="toggleMore(this)">show less</span></span>';
}

function daysAgo(ts){
  if(!ts) return null;
  return Math.floor((Date.now()-ts)/(1000*60*60*24));
}

function bulletList(text){
  if(!text) return null;
  const lines = text.split(/\\n|;/).map(l=>l.trim()).filter(Boolean);
  if(lines.length<2) return e(text);
  return '<ul>'+lines.map(l=>'<li>'+e(l)+'</li>').join('')+'</ul>';
}

// ── Panel card renderers ──────────────────────────────────────────────────

function renderDecision(d){
  const meta = d.metadata||{};
  const conf = meta.confidence||d.status||'';
  const src  = formatSource(meta.source||meta.path||'');
  const days = meta.created_at?daysAgo(meta.created_at):null;
  const raw  = String(meta.content||d.label||'');
  const title = smartTitle(raw);

  let html = '';
  html += '<div class="card-icon-row">'
        + '<span class="card-icon">📋</span>'
        + '<span class="card-type">'+TYPE_LABEL['decision']+'</span>'
        + badgeConf(conf)
        + '</div>';
  html += '<div class="card-title">'+e(title)+'</div>';

  if(meta.adr_context) html += section('CONTEXT', truncated(String(meta.adr_context),400));
  if(raw && raw.length > title.length+10) html += section('WHAT WAS DECIDED', truncated(raw,400));
  if(meta.rationale)        html += section('RATIONALE', truncated(String(meta.rationale),400));
  if(meta.adr_alternatives) html += section('ALTERNATIVES REJECTED', bulletList(String(meta.adr_alternatives)));

  const metaItems = [];
  if(src)         metaItems.push('<span class="card-meta-item"><span>SOURCE</span> '+e(src)+(conf?' · '+conf:'')+'</span>');
  if(meta.symbol) metaItems.push('<span class="card-meta-item"><span>SYMBOL</span> '+e(String(meta.symbol))+'</span>');
  if(meta.adr_status) metaItems.push('<span class="card-meta-item"><span>ADR</span> '+e(String(meta.adr_status))+'</span>');
  if(days!==null) metaItems.push('<span class="card-meta-item"><span>AGE</span> '+days+' days</span>');
  if(metaItems.length) html += '<div class="card-meta-row">'+metaItems.join('')+'</div>';

  return html;
}

function renderRisk(d){
  const meta = d.metadata||{};
  const conf = meta.confidence||d.status||'';
  const raw  = String(meta.content||d.label||'');
  const sev  = parseSev(raw);
  const src  = formatSource(meta.source||meta.path||'');
  const title = smartTitle(raw);

  let html = '';
  html += '<div class="card-icon-row">'
        + '<span class="card-icon">⚠</span>'
        + '<span class="card-type">'+TYPE_LABEL['risk']+'</span>'
        + (sev?badgeSev(sev):badgeConf(conf))
        + '</div>';
  html += '<div class="card-title">'+e(title)+'</div>';

  // Body: strip severity + confidence prefixes, then split at "Mitigation:"
  const body = raw
    .replace(/^\\[(?:critical|high|medium|low)\\]\\s*/i,'')
    .replace(/^(session records suggest:|inferred from documentation:)\\s*/i,'');

  if(body && body.length > title.length+10){
    const mitigIdx = body.search(/\\bmitigation[:\\s]/i);
    if(mitigIdx>0){
      html += section('WHAT CAN GO WRONG', truncated(body.slice(0,mitigIdx).trim(),400));
      html += section('MITIGATION', truncated(body.slice(mitigIdx).replace(/^mitigation[:\\s]*/i,'').trim(),400));
    } else {
      html += section('WHAT CAN GO WRONG', truncated(body,400));
    }
  }

  const metaItems = [];
  if(src)         metaItems.push('<span class="card-meta-item"><span>SOURCE</span> '+e(src)+(conf?' · '+conf:'')+'</span>');
  if(meta.symbol) metaItems.push('<span class="card-meta-item"><span>SYMBOL</span> '+e(String(meta.symbol))+'</span>');
  if(metaItems.length) html += '<div class="card-meta-row">'+metaItems.join('')+'</div>';

  return html;
}

function renderDeferred(d){
  const meta = d.metadata||{};
  const conf = meta.confidence||d.status||'';
  const src  = formatSource(meta.source||meta.path||'');
  const days = meta.created_at?daysAgo(meta.created_at):null;

  let html = '';
  html += '<div class="card-icon-row">'
        + '<span class="card-icon">⏸</span>'
        + '<span class="card-type">'+TYPE_LABEL['deferred']+'</span>'
        + (days!==null?'<span class="card-badge badge-extracted">'+days+' days</span>':badgeConf(conf))
        + '</div>';
  html += '<div class="card-title">'+e(d.label)+'</div>';

  const raw = meta.content||'';
  if(raw && raw!==d.label) html += section('DETAIL', truncated(raw,400));
  if(meta.blocked_by) html += section('BLOCKED BY', e(meta.blocked_by));

  const metaItems = [];
  if(src) metaItems.push('<span class="card-meta-item"><span>SOURCE</span> '+e(src)+(conf?' · '+conf:'')+'</span>');
  if(meta.symbol) metaItems.push('<span class="card-meta-item"><span>SYMBOL</span> '+e(meta.symbol)+'</span>');
  if(metaItems.length) html += '<div class="card-meta-row">'+metaItems.join('')+'</div>';

  return html;
}

function renderSymbol(d){
  const meta = d.metadata||{};
  const count = neighborCount.get(d.id)||0;

  // Count connected record types from adjacency
  const neighbors = adjacency.get(d.id)||new Set();
  const nodeById = new Map(graphData.nodes.map(n=>[n.id,n]));
  const typeCounts = {decision:0,risk:0,deferred:0};
  for(const nid of neighbors){
    const nn = nodeById.get(nid);
    if(nn && typeCounts[nn.type]!==undefined) typeCounts[nn.type]++;
  }
  const recordSummary = Object.entries(typeCounts)
    .filter(([,v])=>v>0)
    .map(([k,v])=>v+' '+k+(v!==1?'s':''))
    .join(' · ');

  let html = '';
  html += '<div class="card-icon-row">'
        + '<span class="card-icon">◆</span>'
        + '<span class="card-type">'+TYPE_LABEL['symbol']+'</span>'
        + '</div>';
  html += '<div class="card-title">'+e(d.label)+'</div>';
  if(recordSummary) html += section('CONNECTED RECORDS', recordSummary);
  if(meta.callers&&meta.callers.length) html += section('CALLERS', e(meta.callers.join(', ')));
  if(meta.path) html += section('FILE', e(meta.path));

  return html;
}

function renderRepo(d){
  const meta = d.metadata||{};
  const nodeById = new Map(graphData.nodes.map(n=>[n.id,n]));
  const neighbors = adjacency.get(d.id)||new Set();

  const exports_ = [];
  const risks_   = [];
  for(const nid of neighbors){
    const nn = nodeById.get(nid);
    if(!nn) continue;
    if(nn.type==='symbol') exports_.push(nn.label);
    if(nn.type==='risk'){
      const sev = (nn.label.match(/^\\[(.*?)\\]/)||[])[1]||'';
      const title = nn.label.replace(/^\\[.*?\\]\\s*/,'');
      risks_.push((sev?sev.toUpperCase()+' — ':'')+title.slice(0,60));
    }
  }

  let html = '';
  html += '<div class="card-icon-row">'
        + '<span class="card-icon">🗂</span>'
        + '<span class="card-type">'+TYPE_LABEL['repo']+'</span>'
        + '</div>';
  html += '<div class="card-title">'+e(d.label)+'</div>';
  if(exports_.length) html += section('EXPORTS TO THIS PORTFOLIO','<ul>'+exports_.map(s=>'<li>'+e(s)+'</li>').join('')+'</ul>');
  if(risks_.length)   html += section('RISKS ON EXPORTS','<ul>'+risks_.map(s=>'<li>⚠ '+e(s)+'</li>').join('')+'</ul>');
  if(meta.path) html += section('PATH', e(meta.path));

  return html;
}

// ── Panel open/close ──────────────────────────────────────────────────────

function selectNode(d){
  let html = '';
  switch(d.type){
    case 'decision': html = renderDecision(d); break;
    case 'risk':     html = renderRisk(d);     break;
    case 'deferred': html = renderDeferred(d); break;
    case 'symbol':   html = renderSymbol(d);   break;
    case 'repo':     html = renderRepo(d);     break;
    default:
      html = '<div class="card-title">'+e(d.label)+'</div>'
           + section('TYPE', e(d.type))
           + section('STATUS', e(d.status||''));
  }
  document.getElementById('panel-body').innerHTML = html;
  panel.classList.add('open');
}

function closePanel(){
  panel.classList.remove('open');
}

function toggleMore(el){
  const card = el.closest('.card-section-body');
  const short = card.querySelector('.text-short');
  const full  = card.querySelector('.text-full');
  if(!short||!full) return;
  const showing = full.style.display==='inline';
  short.style.display = showing?'inline':'none';
  full.style.display  = showing?'none':'inline';
}

// ── Highlight ─────────────────────────────────────────────────────────────

function highlightNode(d){
  const nb = adjacency.get(d.id)||new Set();
  node.classed('dimmed', n=>n.id!==d.id&&!nb.has(n.id));
  link.classed('dimmed', e_=>e_.source.id!==d.id&&e_.target.id!==d.id);
}

function clearHighlight(){
  node.classed('dimmed',false);
  link.classed('dimmed',false);
}

// ── Filters ───────────────────────────────────────────────────────────────

function applyFilters(){
  const tf = document.getElementById('filter-type').value;
  const cf = document.getElementById('filter-conf').value;
  node.style('display',d=>{
    const typeOk = tf==='all'||d.type===tf;
    const confOk = cf==='all'||d.status===cf||(d.metadata||{}).confidence===cf;
    return (typeOk&&confOk)?null:'none';
  });
  const vis = new Set();
  graphData.nodes.forEach(n=>{
    const typeOk = tf==='all'||n.type===tf;
    const confOk = cf==='all'||n.status===cf||(n.metadata||{}).confidence===cf;
    if(typeOk&&confOk) vis.add(n.id);
  });
  link.style('display',d=>{
    const sid = d.source.id||d.source, tid = d.target.id||d.target;
    return vis.has(sid)&&vis.has(tid)?null:'none';
  });
}

// ── Export ────────────────────────────────────────────────────────────────

function exportSvg(){
  const svgEl = document.getElementById('graph');
  const s = new XMLSerializer();
  const blob = new Blob([s.serializeToString(svgEl)],{type:'image/svg+xml'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href=url; a.download='claude-lore-graph.svg'; a.click();
  URL.revokeObjectURL(url);
}

// ── Resize + zoom ─────────────────────────────────────────────────────────

window.addEventListener('resize',()=>{
  const s=getSize();
  sim.force('center',d3.forceCenter(s.w/2,s.h/2)).alpha(0.1).restart();
});

sim.on('end',()=>{
  const bbox=g.node().getBBox();
  if(bbox.width>0&&bbox.height>0){
    const s=getSize();
    const scale=Math.min(0.9,Math.min(s.w/(bbox.width+60),s.h/(bbox.height+60)));
    const tx=(s.w-bbox.width*scale)/2-bbox.x*scale;
    const ty=(s.h-bbox.height*scale)/2-bbox.y*scale;
    svg.transition().duration(600).call(zoom.transform,d3.zoomIdentity.translate(tx,ty).scale(scale));
  }
});
</script>
</body>
</html>`;
}
