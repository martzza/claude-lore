import type { DashboardSummary } from "./summary.js";

// ---------------------------------------------------------------------------
// renderDashboard — produces one self-contained HTML string
// ---------------------------------------------------------------------------

export function renderDashboard(summary: DashboardSummary): string {
  const dataJson = JSON.stringify(summary).replace(/<\/script/gi, "<\\/script");
  const port = summary.system.worker.port ?? 37778;
  const workerUrl = `http://127.0.0.1:${port}`;
  const version = summary.system.version ?? "1.0.0";
  const repoCount = summary.repos.length;
  const portfolioCount = summary.portfolios.length;
  const totalDecisions = summary.totals.decisions;
  const updateAvailable = summary.system.update_check?.available && !summary.system.update_check?.up_to_date;
  const latestVer = summary.system.update_check?.latest;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>claude-lore dashboard</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
<style>
:root{
  --bg:#0f1117;--panel:#1a1d27;--border:#2d3148;--text:#e2e8f0;--muted:#94a3b8;
  --green:#22c55e;--amber:#f59e0b;--red:#ef4444;--blue:#6366f1;--purple:#8b5cf6;
  --radius:8px;--transition:200ms;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;overflow:hidden;height:100vh}
#app{display:flex;flex-direction:column;height:100vh}
#update-banner{background:var(--amber);color:#000;text-align:center;padding:6px;font-size:12px;font-weight:600;display:none}
#topbar{background:var(--panel);border-bottom:1px solid var(--border);padding:8px 16px;display:flex;align-items:center;gap:12px;flex-shrink:0;z-index:100}
#topbar .logo{font-weight:700;color:var(--text);white-space:nowrap}
#topbar .meta{color:var(--muted);font-size:12px;white-space:nowrap}
#topbar .spacer{flex:1}
#topbar .last-updated{color:var(--muted);font-size:11px}
#btn-system{background:var(--border);border:none;color:var(--text);padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px}
#btn-system:hover{background:var(--blue)}
#bell-btn{background:none;border:none;color:var(--muted);cursor:pointer;position:relative;font-size:16px;padding:2px 6px}
#bell-badge{position:absolute;top:-2px;right:-2px;background:var(--red);color:#fff;font-size:9px;border-radius:999px;padding:1px 4px;display:none}
#main{display:flex;flex:1;overflow:hidden}
#graph-panel{flex:1;display:flex;flex-direction:column;overflow:hidden;position:relative}
#graph-controls{background:var(--panel);border-bottom:1px solid var(--border);padding:6px 12px;display:flex;align-items:center;gap:8px;flex-shrink:0}
#graph-controls input[type=text]{background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:4px;padding:3px 8px;font-size:12px;width:160px}
#graph-controls button{background:var(--border);border:none;color:var(--text);padding:3px 8px;border-radius:4px;cursor:pointer;font-size:12px}
#graph-controls button.active{background:var(--blue);color:#fff}
#graph{width:100%;height:100%;background:var(--bg)}
#detail-panel{width:340px;flex-shrink:0;background:var(--panel);border-left:1px solid var(--border);overflow-y:auto;transform:translateX(340px);transition:transform var(--transition)}
#detail-panel.open{transform:translateX(0)}
.dp-header{padding:14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:flex-start}
.dp-close{background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;line-height:1}
.dp-section{padding:12px 14px;border-bottom:1px solid var(--border)}
.dp-section h4{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
.dp-kv{display:flex;justify-content:space-between;margin-bottom:4px;font-size:12px}
.dp-kv .label{color:var(--muted)}
.dp-kv .value{color:var(--text);text-align:right;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:5px}
.conf-bar{height:6px;border-radius:3px;background:var(--border);overflow:hidden;margin-bottom:4px;display:flex}
.conf-seg{height:100%}
.record-item{font-size:11px;color:var(--muted);padding:3px 0;border-bottom:1px solid #2225;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.record-item:last-child{border:none}
.action-btn{width:100%;text-align:left;background:var(--border);border:none;color:var(--text);padding:6px 10px;border-radius:4px;cursor:pointer;font-size:12px;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center}
.action-btn:hover{background:var(--blue)}
.action-btn .spin{animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.step-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 6px;border-radius:4px;background:var(--border);margin-right:3px;margin-bottom:3px}
.step-badge.done{background:#22c55e22;color:var(--green)}
.step-badge.todo{background:#ef444422;color:var(--red)}
#toolbar{background:var(--panel);border-top:1px solid var(--border);padding:6px 12px;display:flex;align-items:center;gap:8px;flex-shrink:0}
#toolbar select{background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:4px;padding:3px 8px;font-size:12px}
#toolbar button{background:var(--border);border:none;color:var(--text);padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px}
#toolbar button:hover{background:var(--blue)}
#action-log{color:var(--muted);font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#feed-strip{background:var(--bg);border-top:1px solid var(--border);height:28px;flex-shrink:0;overflow:hidden;position:relative}
#feed-inner{display:flex;align-items:center;height:100%;padding:0 8px;gap:24px;overflow-x:auto;scrollbar-width:none}
#feed-inner::-webkit-scrollbar{display:none}
.feed-event{white-space:nowrap;font-size:11px;color:var(--muted);display:flex;align-items:center;gap:5px}
.feed-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
#status-panel{position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(15,17,23,.97);z-index:200;overflow-y:auto;display:none}
#status-panel.open{display:block}
.sp-inner{padding:20px;max-width:900px;margin:0 auto}
.sp-title{font-size:18px;font-weight:700;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center}
.sp-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px}
.sp-card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:14px;position:relative;padding-left:18px}
.sp-card::before{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;border-radius:var(--radius) 0 0 var(--radius)}
.sp-card.green::before{background:var(--green)}
.sp-card.amber::before{background:var(--amber)}
.sp-card.red::before{background:var(--red)}
.sp-card.grey::before{background:var(--muted)}
.sp-card h4{font-size:12px;font-weight:600;margin-bottom:8px;color:var(--muted)}
.sp-row{display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px}
.sp-row .ok{color:var(--green)}
.sp-row .warn{color:var(--amber)}
.sp-row .err{color:var(--red)}
#notification-dropdown{position:absolute;top:44px;right:8px;width:300px;background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);z-index:300;display:none;max-height:400px;overflow-y:auto}
#notification-dropdown.open{display:block}
.notif-item{padding:10px 12px;border-bottom:1px solid var(--border);font-size:12px}
.notif-item:last-child{border:none}
.notif-time{color:var(--muted);font-size:10px;margin-top:2px}
#shortcuts-overlay{position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:400;display:none;align-items:center;justify-content:center}
#shortcuts-overlay.open{display:flex}
.shortcuts-box{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:24px;min-width:320px}
.shortcuts-box h3{margin-bottom:14px;font-size:15px}
.shortcut-row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #2225;font-size:13px}
.shortcut-row:last-child{border:none}
.shortcut-row kbd{background:var(--border);border-radius:3px;padding:1px 6px;font-family:monospace;font-size:11px}
#tooltip{position:absolute;background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px;font-size:11px;pointer-events:none;z-index:150;display:none;max-width:220px}
.tooltip-name{font-weight:600;margin-bottom:4px}
.tooltip-meta{color:var(--muted)}
</style>
</head>
<body>
<div id="app">
${updateAvailable ? `<div id="update-banner" style="display:block">Update available: v${latestVer} — run <code>claude-lore update</code> to upgrade</div>` : ""}
<div id="topbar">
  <span class="logo">claude-lore v${version}</span>
  <span class="meta" id="topbar-meta">· Worker ✓ · MCP ${summary.system.mcp.tool_count} tools · ${repoCount} repos · ${portfolioCount} portfolios · ${totalDecisions} decisions</span>
  <span class="spacer"></span>
  <span class="last-updated" id="last-updated">Last updated: 0s ago</span>
  <button id="btn-system">System Status</button>
  <button id="bell-btn">🔔<span id="bell-badge"></span></button>
</div>
<div id="main">
  <div id="graph-panel">
    <div id="graph-controls">
      <input type="text" id="search-input" placeholder="Filter repos…"/>
      <button id="btn-normal" class="active">Normal</button>
      <button id="btn-heatmap">Risk Heatmap</button>
      <button id="btn-force" class="active">Force</button>
      <button id="btn-grid">Grid</button>
      <span style="color:var(--muted);font-size:11px;margin-left:8px"><?> Shortcuts</span>
    </div>
    <svg id="graph"></svg>
    <div id="tooltip"></div>
  </div>
  <div id="detail-panel">
    <div class="dp-header">
      <div>
        <div id="dp-title" style="font-weight:700;font-size:14px;margin-bottom:2px"></div>
        <div id="dp-status" style="font-size:12px;color:var(--muted)"></div>
      </div>
      <button class="dp-close" id="dp-close">×</button>
    </div>
    <div id="dp-body"></div>
  </div>
</div>
<div id="toolbar">
  <select id="portfolio-select"><option value="">All repos</option></select>
  <button id="btn-sync-all">Sync all</button>
  <button id="btn-index-all">Index all</button>
  <button id="btn-run-advisor">Run advisor</button>
  <button id="btn-export-report">Export report</button>
  <span id="action-log"></span>
</div>
<div id="feed-strip"><div id="feed-inner"></div></div>
<div id="status-panel">
  <div class="sp-inner">
    <div class="sp-title">
      System Status
      <button style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px" id="sp-close">×</button>
    </div>
    <div id="sp-content"></div>
  </div>
</div>
<div id="notification-dropdown"></div>
<div id="shortcuts-overlay">
  <div class="shortcuts-box">
    <h3>Keyboard Shortcuts</h3>
    <div class="shortcut-row"><span>Toggle shortcuts</span><kbd>?</kbd></div>
    <div class="shortcut-row"><span>System status</span><kbd>S</kbd></div>
    <div class="shortcut-row"><span>Refresh now</span><kbd>R</kbd></div>
    <div class="shortcut-row"><span>Close panels</span><kbd>Esc</kbd></div>
    <div class="shortcut-row"><span>Focus search</span><kbd>F</kbd></div>
    <div class="shortcut-row"><span>Toggle heatmap</span><kbd>H</kbd></div>
    <div class="shortcut-row"><span>Cycle nodes</span><kbd>Tab</kbd></div>
  </div>
</div>
</div>

<script>
const DASHBOARD_DATA = ${dataJson};
const WORKER_URL = "${workerUrl}";

// ── Helpers ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function statusColour(status) {
  switch(status?.code) {
    case 'healthy':         return getComputedStyle(document.documentElement).getPropertyValue('--green').trim();
    case 'needs_attention': return getComputedStyle(document.documentElement).getPropertyValue('--amber').trim();
    case 'issues':          return getComputedStyle(document.documentElement).getPropertyValue('--red').trim();
    case 'initialised':     return getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
    default:                return getComputedStyle(document.documentElement).getPropertyValue('--blue').trim();
  }
}
function statusColourHeatmap(repo) {
  const risks = repo.critical_risks ?? [];
  if (risks.length > 0) return '#ef4444';
  const r = repo.records ?? {};
  if (r.risks > 3) return '#f59e0b';
  if (!repo.structural?.exists) return '#94a3b8';
  return '#22c55e';
}
function relTime(ms) {
  if (!ms) return 'never';
  const diff = Date.now() - ms;
  if (diff < 60000) return Math.floor(diff/1000)+'s ago';
  if (diff < 3600000) return Math.floor(diff/60000)+'m ago';
  if (diff < 86400000) return Math.floor(diff/3600000)+'h ago';
  return Math.floor(diff/86400000)+'d ago';
}
function nodeRadius(d) {
  const total = d.records?.total ?? 0;
  return 20 + Math.min(35, total / 8);
}
function escHtml(s) {
  return String(s??'').replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]||c));
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentData = DASHBOARD_DATA;
let selectedNode = null;
let viewMode = 'normal';      // 'normal' | 'heatmap'
let layoutMode = 'force';     // 'force' | 'grid'
let filterQuery = '';
let tabIndex = 0;
let notifications = [];
let refreshTimer = null;
let secondsCounter = 0;
let secondsInterval = null;
let simulation = null;
let svgWidth = 0, svgHeight = 0;

// ── D3 Graph ──────────────────────────────────────────────────────────────────
function buildGraph(data) {
  const svg = d3.select('#graph');
  const el = $('graph');
  svgWidth  = el.clientWidth  || 800;
  svgHeight = el.clientHeight || 600;
  svg.attr('width', svgWidth).attr('height', svgHeight);
  svg.selectAll('*').remove();

  const defs = svg.append('defs');
  defs.append('marker')
    .attr('id','arrow')
    .attr('viewBox','0 -5 10 10')
    .attr('refX',20).attr('refY',0)
    .attr('markerWidth',6).attr('markerHeight',6)
    .attr('orient','auto')
    .append('path').attr('d','M0,-5L10,0L0,5').attr('fill','#2d3148');

  const g = svg.append('g');

  // Zoom
  const zoom = d3.zoom()
    .scaleExtent([0.2, 4])
    .on('zoom', e => g.attr('transform', e.transform));
  svg.call(zoom);

  // Nodes
  const nodes = data.repos.map(r => ({...r, id: r.name}));
  const portfolioNodes = data.portfolios
    .filter(p => p.name !== 'default')
    .map(p => ({ id: '__p_'+p.name, name: p.name, type: 'portfolio', repos: p.repos, records: { total: 0 } }));

  // Links (cross-repo)
  const links = [];
  for (const repo of nodes) {
    for (const target of (repo.cross_repo?.imports_from ?? [])) {
      const targetNode = nodes.find(n => n.name === target || n.path === target);
      if (targetNode) links.push({ source: repo.id, target: targetNode.id });
    }
  }

  // Portfolio convex hull
  const hullLayer = g.append('g').attr('class','hulls');
  for (const p of portfolioNodes) {
    hullLayer.append('path').attr('class','hull-'+p.id)
      .attr('stroke','#8b5cf6').attr('stroke-dasharray','5,3')
      .attr('stroke-width',1.5).attr('fill','rgba(139,92,246,.05)');
  }

  // Links
  const linkSel = g.append('g').attr('class','links')
    .selectAll('line').data(links).join('line')
    .attr('stroke','#2d3148').attr('stroke-width',1.5)
    .attr('marker-end','url(#arrow)');

  // Nodes
  const nodeG = g.append('g').attr('class','nodes')
    .selectAll('g').data(nodes).join('g')
    .attr('class','node')
    .attr('data-id', d => d.id)
    .style('cursor','pointer')
    .on('click', (ev, d) => { ev.stopPropagation(); openDetail(d); })
    .on('mouseover', (ev, d) => showTooltip(ev, d))
    .on('mouseout', () => hideTooltip())
    .call(d3.drag()
      .on('start', (ev, d) => { if(!ev.active && simulation) simulation.alphaTarget(.3).restart(); d.fx=d.x; d.fy=d.y; })
      .on('drag',  (ev, d) => { d.fx=ev.x; d.fy=ev.y; })
      .on('end',   (ev, d) => { if(!ev.active && simulation) simulation.alphaTarget(0); d.fx=null; d.fy=null; })
    );

  nodeG.append('circle')
    .attr('class','node-circle')
    .attr('r', d => nodeRadius(d))
    .attr('fill', d => viewMode==='heatmap' ? statusColourHeatmap(d) : statusColour(d.status))
    .attr('stroke','#2d3148').attr('stroke-width',1.5);

  // Advisor badge
  nodeG.append('circle')
    .attr('class','advisor-badge')
    .attr('r', 5)
    .attr('cx', d => nodeRadius(d) - 4)
    .attr('cy', d => -nodeRadius(d) + 4)
    .attr('fill', d => {
      const score = d.advisor?.gap_score ?? 0;
      return score === 0 ? '#22c55e' : score < 50 ? '#f59e0b' : '#ef4444';
    })
    .attr('stroke','#1a1d27').attr('stroke-width',1);

  // Onboarding ring
  nodeG.each(function(d) {
    const steps = d.setup_steps ?? [];
    const complete = steps.filter(s => s.complete).length;
    const total = steps.length || 5;
    if (complete >= total) return;
    const r = nodeRadius(d) + 6;
    const arc = d3.arc()
      .innerRadius(r - 2).outerRadius(r)
      .startAngle(0)
      .endAngle(2 * Math.PI * complete / total);
    d3.select(this).append('path')
      .attr('d', arc)
      .attr('fill','#6366f1').attr('opacity',.8);
  });

  // Labels
  nodeG.append('text')
    .attr('y', d => nodeRadius(d) + 14)
    .attr('text-anchor','middle')
    .attr('font-size',11)
    .attr('fill','#e2e8f0')
    .text(d => d.name);

  // Click on canvas to close detail
  svg.on('click', () => closeDetail());

  // Simulation
  simulation = d3.forceSimulation(nodes)
    .force('link',      d3.forceLink(links).id(d => d.id).distance(140))
    .force('charge',    d3.forceManyBody().strength(-320))
    .force('center',    d3.forceCenter(svgWidth/2, svgHeight/2))
    .force('collision', d3.forceCollide(d => nodeRadius(d) + 18));

  simulation.on('tick', () => {
    linkSel
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    nodeG.attr('transform', d => 'translate('+d.x+','+d.y+')');

    // Update hulls
    for (const p of portfolioNodes) {
      const memberNodes = nodes.filter(n => p.repos?.includes(n.name));
      if (memberNodes.length < 2) continue;
      const points = memberNodes.map(n => [n.x, n.y]);
      const hull = d3.polygonHull(points);
      if (!hull) continue;
      const padded = hull.map(pt => [
        pt[0] + (pt[0] - memberNodes.reduce((s,n)=>s+n.x,0)/memberNodes.length) * .15,
        pt[1] + (pt[1] - memberNodes.reduce((s,n)=>s+n.y,0)/memberNodes.length) * .15
      ]);
      hullLayer.select('.hull-'+p.id)
        .attr('d', 'M'+padded.join('L')+'Z');
    }
  });

  return { svg, g, nodeG, linkSel, nodes, links, zoom };
}

let graphRefs = null;

function updateGraph(data) {
  if (!graphRefs) { graphRefs = buildGraph(data); return; }
  // Smooth update: patch node data without rebuilding simulation
  const { nodeG } = graphRefs;
  nodeG.selectAll('circle.node-circle')
    .transition().duration(500)
    .attr('fill', d => viewMode==='heatmap' ? statusColourHeatmap(d) : statusColour(d.status));
  updateFeed(data);
}

function applyGridLayout(nodes) {
  if (!simulation) return;
  simulation.stop();
  const cols = Math.ceil(Math.sqrt(nodes.length));
  const cellW = svgWidth / (cols + 1);
  const cellH = svgHeight / (Math.ceil(nodes.length / cols) + 1);
  nodes.forEach((n, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    n.fx = cellW * (col + 1);
    n.fy = cellH * (row + 1);
  });
  if (graphRefs) {
    graphRefs.nodeG.transition().duration(600)
      .attr('transform', d => 'translate('+d.fx+','+d.fy+')');
    graphRefs.linkSel
      .attr('x1', d => d.source.fx ?? d.source.x).attr('y1', d => d.source.fy ?? d.source.y)
      .attr('x2', d => d.target.fx ?? d.target.x).attr('y2', d => d.target.fy ?? d.target.y);
  }
}

function applyForceLayout() {
  if (!simulation || !graphRefs) return;
  graphRefs.nodes.forEach(n => { n.fx = null; n.fy = null; });
  simulation.alpha(0.3).restart();
}

// ── Tooltip ──────────────────────────────────────────────────────────────────
function showTooltip(ev, d) {
  const tt = $('tooltip');
  const sparkline = renderSparklineSvg(d.session_sparkline ?? []);
  tt.innerHTML = '<div class="tooltip-name">'+escHtml(d.name)+'</div>'
    +'<div class="tooltip-meta">'+escHtml(d.status?.label ?? '')+'</div>'
    +'<div class="tooltip-meta">'+escHtml(d.records?.total ?? 0)+' records · '+(d.sessions_total??0)+' sessions</div>'
    +'<div style="margin-top:4px">'+sparkline+'</div>';
  tt.style.display = 'block';
  tt.style.left = (ev.clientX + 12)+'px';
  tt.style.top  = (ev.clientY - 8)+'px';
}
function hideTooltip() { $('tooltip').style.display = 'none'; }
function renderSparklineSvg(data) {
  if (!data || data.length === 0) return '';
  const max = Math.max(...data, 1);
  const w = 120, h = 24;
  const pts = data.map((v, i) => {
    const x = i * w / (data.length - 1);
    const y = h - (v / max) * h;
    return x+','+y;
  }).join(' ');
  return '<svg width="'+w+'" height="'+h+'" style="display:block"><polyline points="'+pts+'" fill="none" stroke="#6366f1" stroke-width="1.5"/></svg>';
}

// ── Detail panel ─────────────────────────────────────────────────────────────
function openDetail(repo) {
  selectedNode = repo;
  const panel = $('detail-panel');
  panel.classList.add('open');
  $('dp-title').textContent = repo.name;
  const sc = statusColour(repo.status);
  $('dp-status').innerHTML = '<span class="status-dot" style="background:'+sc+'"></span>'+escHtml(repo.status?.label ?? '');
  $('dp-body').innerHTML = buildDetailHTML(repo);
}
function closeDetail() {
  selectedNode = null;
  $('detail-panel').classList.remove('open');
}

function buildDetailHTML(r) {
  const lq = r.lore_quality ?? {};
  const rec = r.records ?? {};
  const total = lq.total || 1;
  const confPct = Math.round((lq.confirmed / total) * 100);
  const extPct  = Math.round((lq.extracted  / total) * 100);
  const infPct  = Math.round((lq.inferred   / total) * 100);
  const contPct = Math.round((lq.contested  / total) * 100);
  const maturityColour = lq.maturity === 'mature' ? '#22c55e' : lq.maturity === 'developing' ? '#f59e0b' : '#ef4444';

  let html = '';

  // Git
  if (r.git?.branch) {
    html += '<div class="dp-section"><h4>Git</h4>';
    html += '<div class="dp-kv"><span class="label">Branch</span><span class="value">'+escHtml(r.git.branch)+(r.git.dirty?' *':'')+'</span></div>';
    if (r.git.last_commit) html += '<div class="dp-kv"><span class="label">Last commit</span><span class="value" title="'+escHtml(r.git.last_commit)+'">'+escHtml(r.git.last_commit.slice(0,40))+'</span></div>';
    if (r.git.last_commit_relative) html += '<div class="dp-kv"><span class="label">When</span><span class="value">'+escHtml(r.git.last_commit_relative)+'</span></div>';
    html += '</div>';
  }

  // Records
  html += '<div class="dp-section"><h4>Records</h4>';
  html += '<div class="dp-kv"><span class="label">Decisions</span><span class="value">'+rec.decisions+'</span></div>';
  html += '<div class="dp-kv"><span class="label">Risks</span><span class="value">'+rec.risks+'</span></div>';
  html += '<div class="dp-kv"><span class="label">Deferred (open)</span><span class="value">'+rec.deferred_open+'</span></div>';
  html += '<div class="dp-kv"><span class="label">Confirmed</span><span class="value" style="color:#22c55e">'+rec.confirmed+'</span></div>';
  html += '<div class="dp-kv"><span class="label">Pending review</span><span class="value" style="color:'+(rec.pending_review>10?'#ef4444':rec.pending_review>0?'#f59e0b':'#22c55e')+'">'+rec.pending_review+'</span></div>';
  html += '</div>';

  // Lore quality
  html += '<div class="dp-section"><h4>Lore Quality — <span style="color:'+maturityColour+'">'+escHtml(lq.maturity??'early')+'</span></h4>';
  html += '<div class="conf-bar">';
  html += '<div class="conf-seg" style="width:'+confPct+'%;background:#22c55e" title="confirmed: '+lq.confirmed+'"></div>';
  html += '<div class="conf-seg" style="width:'+extPct+'%;background:#6366f1"  title="extracted: '+lq.extracted+'"></div>';
  html += '<div class="conf-seg" style="width:'+infPct+'%;background:#f59e0b"  title="inferred: '+lq.inferred+'"></div>';
  html += '<div class="conf-seg" style="width:'+contPct+'%;background:#ef4444" title="contested: '+lq.contested+'"></div>';
  html += '</div>';
  html += '<div style="display:flex;gap:8px;font-size:10px;color:var(--muted);margin-top:3px">';
  html += '<span style="color:#22c55e">■ confirmed '+confPct+'%</span>';
  html += '<span style="color:#6366f1">■ extracted '+extPct+'%</span>';
  html += '<span style="color:#f59e0b">■ inferred '+infPct+'%</span>';
  html += '</div></div>';

  // Advisor
  html += '<div class="dp-section"><h4>Advisor</h4>';
  html += '<div class="dp-kv"><span class="label">Gap score</span><span class="value">'+((r.advisor?.gap_score)??0)+'</span></div>';
  html += '<div class="dp-kv"><span class="label">Priority gaps</span><span class="value">'+((r.advisor?.priority_gaps)??0)+'</span></div>';
  html += '<div class="dp-kv"><span class="label">Quick wins</span><span class="value">'+((r.advisor?.quick_wins)??0)+'</span></div>';
  html += '</div>';

  // Structural
  const si = r.structural ?? {};
  html += '<div class="dp-section"><h4>Structural Index</h4>';
  html += '<div class="dp-kv"><span class="label">Indexed</span><span class="value" style="color:'+(si.exists?'#22c55e':'#ef4444')+'">'+(si.exists?'Yes':'No')+'</span></div>';
  if (si.exists) {
    html += '<div class="dp-kv"><span class="label">Symbols</span><span class="value">'+si.symbol_count+'</span></div>';
    html += '<div class="dp-kv"><span class="label">Edges</span><span class="value">'+si.edge_count+'</span></div>';
    if (si.indexed_at) html += '<div class="dp-kv"><span class="label">Indexed</span><span class="value">'+relTime(si.indexed_at)+'</span></div>';
  }
  html += '</div>';

  // Last session
  html += '<div class="dp-section"><h4>Last Session</h4>';
  if (r.last_session?.ended_at) {
    html += '<div class="dp-kv"><span class="label">When</span><span class="value">'+relTime(r.last_session.ended_at)+'</span></div>';
    if (r.last_session?.summary) html += '<div style="font-size:11px;color:var(--muted);margin-top:4px;line-height:1.4">'+escHtml(r.last_session.summary.slice(0,200))+'</div>';
  } else {
    html += '<div style="font-size:11px;color:var(--muted)">No sessions recorded</div>';
  }
  html += '<div style="margin-top:6px">'+renderSparklineSvg(r.session_sparkline ?? [])+'</div>';
  html += '</div>';

  // Top decisions
  if ((r.top_decisions ?? []).length > 0) {
    html += '<div class="dp-section"><h4>Top Confirmed Decisions</h4>';
    for (const d of r.top_decisions) {
      html += '<div class="record-item" title="'+escHtml(d.content)+'">'+escHtml(d.content)+'</div>';
    }
    html += '</div>';
  }

  // Critical risks
  if ((r.critical_risks ?? []).length > 0) {
    html += '<div class="dp-section"><h4>Risks</h4>';
    for (const rk of r.critical_risks) {
      html += '<div class="record-item" style="color:#f59e0b" title="'+escHtml(rk.content)+'">'+escHtml(rk.content)+'</div>';
    }
    html += '</div>';
  }

  // Open deferred
  if ((r.open_deferred ?? []).length > 0) {
    html += '<div class="dp-section"><h4>Open Deferred</h4>';
    for (const d of r.open_deferred) {
      html += '<div class="record-item" title="'+escHtml(d.content)+'">'+escHtml(d.content)+'</div>';
    }
    html += '</div>';
  }

  // Manifest
  html += '<div class="dp-section"><h4>Manifest</h4>';
  html += '<div class="dp-kv"><span class="label">Portfolio</span><span class="value">'+escHtml(r.portfolio??'default')+'</span></div>';
  html += '<div class="dp-kv"><span class="label">Last synced</span><span class="value">'+relTime(r.synced_at)+'</span></div>';
  html += '</div>';

  // Setup status
  const steps = r.setup_steps ?? [];
  const allDone = steps.every(s => s.complete);
  if (!allDone) {
    html += '<div class="dp-section"><h4>Setup Status</h4>';
    for (const s of steps) {
      html += '<span class="step-badge '+(s.complete?'done':'todo')+'">'+escHtml(s.label)+'</span>';
    }
    html += '</div>';
  }

  // Actions
  html += '<div class="dp-section"><h4>Actions</h4>';
  html += actionButton('run_index',    r.path, 'Run Index');
  html += actionButton('sync_manifest',r.path, 'Sync Manifest');
  html += actionButton('open_review',  r.path, 'Open Review Queue');
  html += actionButton('open_folder',  r.path, 'Open in Finder');
  html += actionButton('run_advisor',  r.path, 'Run Advisor');
  html += '</div>';

  return html;
}

function actionButton(action, repoPath, label) {
  return '<button class="action-btn" onclick="runAction(\''+action+'\',\''+escHtml(repoPath)+'\',this)"><span>'+label+'</span><span></span></button>';
}

async function runAction(action, repoPath, btn) {
  const spinner = btn.querySelector('span:last-child');
  spinner.textContent = '⟳';
  spinner.classList.add('spin');
  btn.disabled = true;
  try {
    const resp = await fetch(WORKER_URL+'/api/dashboard/action', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ action, repo_path: repoPath }),
    });
    const data = await resp.json();
    spinner.classList.remove('spin');
    spinner.textContent = resp.ok ? '✓' : '✗';
    if (data.url) window.open(data.url, '_blank');
    setActionLog(action+': '+(data.message ?? (resp.ok?'done':'error')));
  } catch(e) {
    spinner.classList.remove('spin');
    spinner.textContent = '✗';
    setActionLog('Error: '+e.message);
  } finally {
    btn.disabled = false;
    setTimeout(() => { spinner.textContent = ''; }, 2000);
  }
}

function setActionLog(msg) {
  const el = $('action-log');
  el.textContent = msg;
  setTimeout(() => { el.textContent = ''; }, 5000);
}

// ── System Status Panel ───────────────────────────────────────────────────────
function buildSystemPanel(data) {
  const sys = data.system ?? {};
  const w = sys.worker ?? {};
  const mcp = sys.mcp ?? {};
  const dbs = sys.databases ?? {};
  const ai = sys.ai_compression ?? {};
  const turso = sys.turso ?? {};
  const pm2 = sys.pm2 ?? {};
  const env = sys.environment ?? {};
  const vc = sys.update_check ?? {};
  const rq = sys.review_queue ?? {};

  function card(title, colour, rows) {
    return '<div class="sp-card '+colour+'"><h4>'+title+'</h4>'+rows+'</div>';
  }
  function row(label, value, cls='') {
    return '<div class="sp-row"><span>'+escHtml(label)+'</span><span class="'+cls+'">'+escHtml(String(value??''))+'</span></div>';
  }

  const workerColour = w.running ? 'green' : 'red';
  const workerRows = row('Status', w.running?'running':'stopped', w.running?'ok':'err')
    + row('Port', w.port??37778)
    + row('Mode', w.mode??'solo')
    + row('Uptime', w.uptime_seconds ? Math.floor(w.uptime_seconds/60)+'m' : 'unknown');

  const mcpColour = mcp.tool_count >= 20 ? 'green' : 'amber';
  const mcpRows = row('Tools', mcp.tool_count??0)
    + row('Total calls', mcp.total_calls??0)
    + row('Calls today', mcp.calls_today??0)
    + row('Last call', relTime(mcp.last_call_at));

  const dbOk = dbs.sessions?.ok && dbs.registry?.ok;
  const dbColour = dbOk ? 'green' : 'red';
  const dbRows = row('Sessions', dbs.sessions?.ok ? dbs.sessions.row_count+' rows' : 'error', dbs.sessions?.ok?'ok':'err')
    + row('Registry', dbs.registry?.ok ? dbs.registry.row_count+' rows' : 'error', dbs.registry?.ok?'ok':'err')
    + row('Personal', dbs.personal?.ok ? dbs.personal.row_count+' rows' : 'error', dbs.personal?.ok?'ok':'err');

  const aiColour = ai.api_key_set ? 'green' : 'amber';
  const aiRows = row('API key', ai.api_key_set?'set':'not set', ai.api_key_set?'ok':'warn')
    + row('Turso', turso.connected?'connected':'local only', turso.connected?'ok':'warn')
    + row('Compressed', ai.sessions_compressed??0)
    + row('PM2', pm2.running?'running':'not found', pm2.running?'ok':'warn');

  const vcColour = vc.available && !vc.up_to_date ? 'amber' : 'green';
  const vcRows = row('Current', vc.current??'1.0.0')
    + row('Latest', vc.latest??(vc.available?'unknown':'checking…'))
    + row('Up to date', vc.up_to_date?'yes':'update available', vc.up_to_date?'ok':'warn');

  const rqColour = rq.total_pending > 20 ? 'red' : rq.total_pending > 5 ? 'amber' : 'green';
  const rqRows = row('Total pending', rq.total_pending??0, rq.total_pending>20?'err':rq.total_pending>0?'warn':'ok')
    + (rq.by_repo??[]).slice(0,4).map(r2 =>
        row(r2.repo.split('/').pop()??r2.repo, r2.pending+' ('+(r2.oldest_age_days??0)+'d old)', r2.pending>10?'err':'warn')
      ).join('');

  const envColour = env.ANTHROPIC_API_KEY==='set' ? 'green' : 'amber';
  const envRows = Object.entries(env).map(([k,v]) =>
    row(k, v, v==='set'?'ok':'warn')
  ).join('');

  return '<div class="sp-grid">'
    + card('Worker',         workerColour, workerRows)
    + card('MCP Server',     mcpColour,    mcpRows)
    + card('Databases',      dbColour,     dbRows)
    + card('AI / Turso / PM2', aiColour,   aiRows)
    + card('Version Check',  vcColour,     vcRows)
    + card('Review Queue',   rqColour,     rqRows)
    + '</div>'
    + '<div class="sp-grid">'
    + card('Environment',    envColour,    envRows)
    + '</div>';
}

// ── Portfolio toolbar ─────────────────────────────────────────────────────────
function populatePortfolioSelect(data) {
  const sel = $('portfolio-select');
  sel.innerHTML = '<option value="">All repos</option>';
  for (const p of (data.portfolios ?? [])) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name+' ('+p.repo_count+')';
    sel.appendChild(opt);
  }
}

async function toolbarAction(action) {
  setActionLog(action+': running…');
  try {
    const resp = await fetch(WORKER_URL+'/api/dashboard/action', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ action }),
    });
    const data = await resp.json();
    setActionLog(action+': '+(data.message ?? (resp.ok?'done':'error')));
  } catch(e) {
    setActionLog(action+' error: '+e.message);
  }
}

async function exportReport() {
  const portfolio = $('portfolio-select').value;
  const name = portfolio || 'default';
  const resp = await fetch(WORKER_URL+'/api/portfolio/report', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name, format: 'markdown' }),
  });
  if (!resp.ok) { setActionLog('Export failed'); return; }
  const text = await resp.text();
  const blob = new Blob([text], {type:'text/plain'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'portfolio-report-'+name+'.md';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  setActionLog('Report exported');
}

// ── Activity feed ─────────────────────────────────────────────────────────────
function updateFeed(data) {
  const feed = $('feed-inner');
  const events = (data.activity_feed ?? []).slice(0, 30);
  feed.innerHTML = events.map(ev => {
    const repo = (ev.repo ?? '').split('/').pop() ?? ev.repo;
    const repoData = data.repos?.find(r => r.path === ev.repo || r.name === repo);
    const colour = repoData ? statusColour(repoData.status) : '#94a3b8';
    return '<div class="feed-event"><span class="feed-dot" style="background:'+colour+'"></span>'
      + '<span>'+escHtml(repo)+' · '+relTime(ev.timestamp)+' · '+escHtml(ev.detail.slice(0,60))+'</span></div>';
  }).join('');
}

// ── Notifications ─────────────────────────────────────────────────────────────
function generateNotifications(oldData, newData) {
  const newNotifs = [];
  for (const repo of (newData.repos ?? [])) {
    const old = (oldData.repos ?? []).find(r => r.path === repo.path);
    if (!old) { newNotifs.push({ text: 'New repo: '+repo.name, time: Date.now() }); continue; }
    if (old.status?.code !== repo.status?.code) {
      newNotifs.push({ text: repo.name+': status changed to '+repo.status?.label, time: Date.now() });
    }
    if ((repo.records?.pending_review ?? 0) > (old.records?.pending_review ?? 0)) {
      newNotifs.push({ text: repo.name+': '+repo.records.pending_review+' pending reviews', time: Date.now() });
    }
  }
  notifications = [...newNotifs, ...notifications].slice(0, 20);
  const badge = $('bell-badge');
  if (newNotifs.length > 0) {
    badge.textContent = newNotifs.length;
    badge.style.display = 'block';
  }
  renderNotifications();
}

function renderNotifications() {
  const dd = $('notification-dropdown');
  if (notifications.length === 0) {
    dd.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:12px">No notifications</div>';
    return;
  }
  dd.innerHTML = notifications.map(n =>
    '<div class="notif-item">'+escHtml(n.text)
    +'<div class="notif-time">'+relTime(n.time)+'</div></div>'
  ).join('');
}

// ── Search filter ─────────────────────────────────────────────────────────────
function applyFilter(query) {
  filterQuery = query.toLowerCase();
  if (!graphRefs) return;
  graphRefs.nodeG.style('opacity', d => {
    if (!filterQuery) return 1;
    return d.name.toLowerCase().includes(filterQuery) ? 1 : 0.15;
  });
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', ev => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    if (ev.key === 'Escape') document.activeElement.blur();
    return;
  }
  switch(ev.key) {
    case '?': toggleShortcuts(); break;
    case 's': case 'S': toggleSystemStatus(); break;
    case 'r': case 'R': doRefresh(); break;
    case 'Escape': closeAll(); break;
    case 'f': case 'F': $('search-input').focus(); ev.preventDefault(); break;
    case 'h': case 'H': toggleHeatmap(); break;
    case 'Tab': ev.preventDefault(); cycleNodes(); break;
  }
});
function toggleShortcuts() { $('shortcuts-overlay').classList.toggle('open'); }
function toggleSystemStatus() {
  const sp = $('status-panel');
  if (sp.classList.contains('open')) { sp.classList.remove('open'); return; }
  $('sp-content').innerHTML = buildSystemPanel(currentData);
  sp.classList.add('open');
}
function closeAll() {
  $('status-panel').classList.remove('open');
  $('shortcuts-overlay').classList.remove('open');
  $('notification-dropdown').classList.remove('open');
  closeDetail();
}
function toggleHeatmap() {
  viewMode = viewMode === 'heatmap' ? 'normal' : 'heatmap';
  $('btn-heatmap').classList.toggle('active', viewMode === 'heatmap');
  $('btn-normal').classList.toggle('active', viewMode === 'normal');
  if (graphRefs) {
    graphRefs.nodeG.selectAll('circle.node-circle')
      .transition().duration(500)
      .attr('fill', d => viewMode==='heatmap' ? statusColourHeatmap(d) : statusColour(d.status));
  }
}
function cycleNodes() {
  const repos = currentData.repos ?? [];
  if (repos.length === 0) return;
  tabIndex = (tabIndex + 1) % repos.length;
  openDetail(repos[tabIndex]);
}

// ── Auto-refresh ──────────────────────────────────────────────────────────────
async function doRefresh() {
  try {
    const data = await fetch(WORKER_URL+'/api/dashboard/summary').then(r => r.json());
    generateNotifications(currentData, data);
    currentData = data;
    updateGraph(data);
    updateFeed(data);
    secondsCounter = 0;
  } catch { /* worker may be restarting */ }
}

function startRefresh() {
  refreshTimer = setInterval(() => doRefresh(), 30000);
  secondsInterval = setInterval(() => {
    secondsCounter++;
    $('last-updated').textContent = 'Last updated: '+secondsCounter+'s ago';
  }, 1000);
}

// ── Topbar ────────────────────────────────────────────────────────────────────
function updateTopBar(data) {
  const sys = data.system ?? {};
  const mcp = sys.mcp ?? {};
  $('topbar-meta').textContent = '· Worker ✓ · MCP '+mcp.tool_count+' tools · '
    +(data.repos?.length??0)+' repos · '+(data.portfolios?.length??0)+' portfolios · '
    +data.totals?.decisions+' decisions';
}

// ── Wire up ───────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  graphRefs = buildGraph(currentData);
  populatePortfolioSelect(currentData);
  updateFeed(currentData);
  renderNotifications();

  // Controls
  $('btn-normal').addEventListener('click',  () => { viewMode='normal';  toggleHeatmap(); toggleHeatmap(); $('btn-normal').classList.add('active'); $('btn-heatmap').classList.remove('active'); });
  $('btn-heatmap').addEventListener('click', () => { if(viewMode!=='heatmap') toggleHeatmap(); });
  $('btn-force').addEventListener('click',   () => { layoutMode='force'; $('btn-force').classList.add('active'); $('btn-grid').classList.remove('active'); applyForceLayout(); });
  $('btn-grid').addEventListener('click',    () => { layoutMode='grid';  $('btn-grid').classList.add('active'); $('btn-force').classList.remove('active'); if(graphRefs) applyGridLayout(graphRefs.nodes); });
  $('search-input').addEventListener('input', ev => applyFilter(ev.target.value));

  // Toolbar
  $('btn-sync-all').addEventListener('click',    () => toolbarAction('sync_all'));
  $('btn-index-all').addEventListener('click',   () => toolbarAction('index_all'));
  $('btn-run-advisor').addEventListener('click', () => toolbarAction('run_advisor'));
  $('btn-export-report').addEventListener('click', exportReport);

  // Detail panel close
  $('dp-close').addEventListener('click', closeDetail);

  // System panel
  $('btn-system').addEventListener('click', toggleSystemStatus);
  $('sp-close').addEventListener('click', () => $('status-panel').classList.remove('open'));

  // Bell
  $('bell-btn').addEventListener('click', () => {
    $('bell-badge').style.display = 'none';
    $('notification-dropdown').classList.toggle('open');
  });

  // Close dropdown on outside click
  document.addEventListener('click', ev => {
    if (!$('notification-dropdown').contains(ev.target) && ev.target !== $('bell-btn')) {
      $('notification-dropdown').classList.remove('open');
    }
  });

  // Shortcuts overlay close on click outside
  $('shortcuts-overlay').addEventListener('click', ev => {
    if (ev.target === $('shortcuts-overlay')) toggleShortcuts();
  });

  // Expose runAction for inline onclick
  window.runAction = runAction;

  startRefresh();
});

// Resize handler
window.addEventListener('resize', () => {
  if (graphRefs) {
    const el = $('graph');
    svgWidth  = el.clientWidth;
    svgHeight = el.clientHeight;
    d3.select('#graph').attr('width', svgWidth).attr('height', svgHeight);
    if (simulation) simulation.force('center', d3.forceCenter(svgWidth/2, svgHeight/2)).alpha(0.1).restart();
  }
});
</script>
</body>
</html>`;
}
