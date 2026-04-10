import type { WikiPage } from "./wiki.js";

// ---------------------------------------------------------------------------
// Transformed shape for the HTML renderer
// ---------------------------------------------------------------------------

interface HtmlSymbol {
  name:          string;
  file:          string;
  line:          number;
  kind:          string;
  exported:      boolean;
  is_test:       boolean;
  callers:       string[];
  callees:       string[];
  risk_score:    number;
  has_reasoning: boolean;
}

interface HtmlRecord {
  title:      string;
  confidence: string;
  severity?:  string;
}

interface HtmlPage {
  community:    string;
  community_id: string;
  description:  string;
  hub_symbol:   string | null;
  size:         number;
  files:        string[];
  coverage_pct: number;
  decisions:    HtmlRecord[];
  risks:        HtmlRecord[];
  deferred:     { title: string }[];
  symbols:      HtmlSymbol[];
}

function firstLine(text: string): string {
  return text.split("\n")[0]!.trim().slice(0, 140);
}

function confidenceToSeverity(confidence: string): string {
  switch (confidence) {
    case "confirmed": return "high";
    case "extracted": return "medium";
    default:          return "low";
  }
}

function toHtmlPages(pages: WikiPage[]): HtmlPage[] {
  return pages.map(p => ({
    community:    p.community_name,
    community_id: p.community_id,
    description:  p.description,
    hub_symbol:   p.hub_symbol,
    size:         p.size,
    files:        p.files,
    coverage_pct: p.coverage_pct,
    decisions:    p.decisions.map(d => ({
      title:      firstLine(d.content),
      confidence: d.confidence,
    })),
    risks: p.risks.map(r => ({
      title:      firstLine(r.content),
      confidence: r.confidence,
      severity:   confidenceToSeverity(r.confidence),
    })),
    deferred: p.deferred.map(d => ({
      title: firstLine(d.content),
    })),
    symbols: p.symbols.map(s => ({
      name:          s.name,
      file:          s.file,
      line:          s.line,
      kind:          s.kind,
      exported:      s.exported,
      is_test:       s.is_test,
      callers:       s.callers,
      callees:       s.callees,
      risk_score:    s.risk_score,
      has_reasoning: s.has_reasoning,
    })),
  }));
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function renderWikiHtml(pages: WikiPage[]): string {
  const dataJson = JSON.stringify(toHtmlPages(pages));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>claude-lore wiki</title>
<style>
  :root {
    --bg:         #0f1117;
    --panel:      #1a1d27;
    --border:     #2d3148;
    --text:       #e2e8f0;
    --muted:      #94a3b8;
    --green:      #22c55e;
    --amber:      #f59e0b;
    --red:        #ef4444;
    --blue:       #6366f1;
    --purple:     #8b5cf6;
    --mono:       'JetBrains Mono', 'Fira Code', monospace;
    --sans:       -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    display: flex;
    height: 100vh;
    overflow: hidden;
  }

  /* ── Sidebar ───────────────────────────────────────────────────── */
  #sidebar {
    width: 260px;
    min-width: 200px;
    background: var(--panel);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  #sidebar-header {
    padding: 16px;
    border-bottom: 1px solid var(--border);
  }

  #sidebar-header h1 {
    font-size: 13px;
    font-weight: 600;
    color: var(--purple);
    letter-spacing: 0.05em;
    text-transform: uppercase;
    margin-bottom: 10px;
  }

  #search {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    padding: 7px 10px;
    font-size: 13px;
    outline: none;
  }

  #search:focus { border-color: var(--blue); }

  #community-list {
    overflow-y: auto;
    flex: 1;
    padding: 8px 0;
  }

  .community-item {
    padding: 8px 16px;
    cursor: pointer;
    border-left: 3px solid transparent;
    display: flex;
    align-items: center;
    gap: 8px;
    transition: background 0.1s;
  }

  .community-item:hover { background: rgba(99,102,241,0.08); }

  .community-item.active {
    border-left-color: var(--purple);
    background: rgba(139,92,246,0.12);
  }

  .community-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .community-size {
    font-size: 11px;
    color: var(--muted);
    font-family: var(--mono);
  }

  /* ── Main panel ────────────────────────────────────────────────── */
  #main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  #topbar {
    padding: 12px 24px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 12px;
    color: var(--muted);
  }

  #topbar .breadcrumb { color: var(--text); font-weight: 500; }

  .nav-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--muted);
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    margin-left: auto;
  }

  .nav-btn:hover { border-color: var(--blue); color: var(--text); }

  #content {
    flex: 1;
    overflow-y: auto;
    padding: 24px;
  }

  /* ── Community detail ──────────────────────────────────────────── */
  .community-header {
    margin-bottom: 24px;
  }

  .community-header h2 {
    font-size: 22px;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 6px;
  }

  .community-meta {
    font-size: 13px;
    color: var(--muted);
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }

  .meta-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .coverage-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
  }

  .bar-track {
    flex: 1;
    max-width: 200px;
    height: 6px;
    background: var(--border);
    border-radius: 3px;
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    border-radius: 3px;
    background: var(--green);
    transition: width 0.3s;
  }

  .bar-fill.low  { background: var(--red); }
  .bar-fill.mid  { background: var(--amber); }
  .bar-fill.high { background: var(--green); }

  /* ── Section cards ─────────────────────────────────────────────── */
  .section {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 16px;
    overflow: hidden;
  }

  .section-header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .section-count {
    background: var(--bg);
    border-radius: 10px;
    padding: 2px 8px;
    font-size: 11px;
    color: var(--blue);
  }

  /* ── Symbol table ──────────────────────────────────────────────── */
  .symbol-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  .symbol-table th {
    padding: 10px 16px;
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border);
  }

  .symbol-table td {
    padding: 10px 16px;
    border-bottom: 1px solid rgba(45,49,72,0.5);
    vertical-align: middle;
  }

  .symbol-table tr:last-child td { border-bottom: none; }

  .symbol-table tr:hover td { background: rgba(99,102,241,0.05); cursor: pointer; }

  .sym-name {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--blue);
    font-weight: 500;
  }

  .sym-file {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }

  .kind-badge {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11px;
    font-family: var(--mono);
    background: rgba(99,102,241,0.15);
    color: var(--blue);
  }

  .exported-tick { color: var(--green); font-size: 12px; }

  .risk-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .risk-low      { background: var(--green); }
  .risk-medium   { background: var(--amber); }
  .risk-high     { background: var(--red); }
  .risk-critical { background: #dc2626; box-shadow: 0 0 6px #dc2626; }

  /* ── Records ───────────────────────────────────────────────────── */
  .record-list { padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }

  .record-item {
    padding: 10px 12px;
    background: var(--bg);
    border-radius: 6px;
    border-left: 3px solid var(--border);
  }

  .record-item.confirmed  { border-left-color: var(--green); }
  .record-item.extracted  { border-left-color: var(--blue); }
  .record-item.inferred   { border-left-color: var(--muted); }
  .record-item.risk-high  { border-left-color: var(--red); }
  .record-item.risk-critical { border-left-color: #dc2626; }
  .record-item.risk-medium { border-left-color: var(--amber); }

  .record-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
    margin-bottom: 4px;
  }

  .record-meta {
    font-size: 11px;
    color: var(--muted);
    font-family: var(--mono);
  }

  /* ── Symbol detail panel ───────────────────────────────────────── */
  #sym-panel {
    position: fixed;
    right: 0;
    top: 0;
    bottom: 0;
    width: 360px;
    background: var(--panel);
    border-left: 1px solid var(--border);
    transform: translateX(100%);
    transition: transform 0.2s ease;
    overflow-y: auto;
    z-index: 100;
    padding: 20px;
  }

  #sym-panel.open { transform: translateX(0); }

  #sym-panel-close {
    position: absolute;
    top: 12px;
    right: 16px;
    background: none;
    border: none;
    color: var(--muted);
    font-size: 18px;
    cursor: pointer;
    line-height: 1;
  }

  #sym-panel-close:hover { color: var(--text); }

  .sym-panel-name {
    font-family: var(--mono);
    font-size: 16px;
    color: var(--blue);
    font-weight: 600;
    margin-bottom: 4px;
    padding-right: 30px;
  }

  .sym-panel-file {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    margin-bottom: 16px;
  }

  .sym-panel-section {
    margin-bottom: 16px;
  }

  .sym-panel-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    margin-bottom: 6px;
  }

  .caller-chip {
    display: inline-block;
    background: rgba(99,102,241,0.15);
    border-radius: 4px;
    padding: 3px 8px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--blue);
    margin: 2px;
    cursor: pointer;
  }

  .caller-chip:hover { background: rgba(99,102,241,0.3); }

  /* ── File list ─────────────────────────────────────────────────── */
  .file-list { padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; }

  .file-item {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    padding: 4px 0;
  }

  /* ── Symbol search ─────────────────────────────────────────────── */
  .sym-search-wrap { padding: 12px 16px; border-bottom: 1px solid var(--border); }

  .sym-search {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    padding: 7px 10px;
    font-size: 13px;
    outline: none;
  }

  .sym-search:focus { border-color: var(--blue); }

  /* ── Index view ────────────────────────────────────────────────── */
  #index-view {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
  }

  .index-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    cursor: pointer;
    transition: border-color 0.15s;
  }

  .index-card:hover { border-color: var(--purple); }

  .index-card-name {
    font-size: 15px;
    font-weight: 600;
    color: var(--purple);
    margin-bottom: 6px;
  }

  .index-card-desc {
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 12px;
    line-height: 1.5;
  }

  .index-card-stats {
    display: flex;
    gap: 12px;
    font-size: 12px;
    font-family: var(--mono);
    color: var(--muted);
  }

  .stat-value { color: var(--text); font-weight: 500; }

  /* ── Scrollbar ─────────────────────────────────────────────────── */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #3d4166; }
</style>
</head>
<body>

<div id="sidebar">
  <div id="sidebar-header">
    <h1>claude-lore wiki</h1>
    <input id="search" type="text" placeholder="Search communities..." autocomplete="off">
  </div>
  <div id="community-list">
    <div class="community-item active" data-idx="-1" onclick="showIndex()">
      <span class="community-name">\u2190 All communities</span>
    </div>
  </div>
</div>

<div id="main">
  <div id="topbar">
    <span id="breadcrumb" class="breadcrumb">All communities</span>
    <button class="nav-btn" id="prev-btn" onclick="navigate(-1)">\u2190 Prev</button>
    <button class="nav-btn" id="next-btn" onclick="navigate(1)">Next \u2192</button>
  </div>
  <div id="content"></div>
</div>

<div id="sym-panel">
  <button id="sym-panel-close" onclick="closeSymPanel()">\u00d7</button>
  <div id="sym-panel-content"></div>
</div>

<script>
const PAGES = ${dataJson};
let currentIdx = -1;

// ── Boot ──────────────────────────────────────────────────────────────────────

function boot() {
  buildSidebar();
  showIndex();
  document.getElementById('search').addEventListener('input', filterSidebar);
}

function buildSidebar() {
  const list = document.getElementById('community-list');
  PAGES.forEach((page, i) => {
    const item = document.createElement('div');
    item.className = 'community-item';
    item.dataset.idx = i;
    item.onclick = () => showCommunity(i);
    item.innerHTML =
      '<span class="community-name">' + escHtml(page.community) + '</span>' +
      '<span class="community-size">' + page.symbols.length + '</span>';
    list.appendChild(item);
  });
}

function filterSidebar(e) {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll('.community-item[data-idx]').forEach(el => {
    if (el.dataset.idx === '-1') return;
    const name = el.querySelector('.community-name').textContent.toLowerCase();
    el.style.display = name.includes(q) ? '' : 'none';
  });
}

// ── Navigation ────────────────────────────────────────────────────────────────

function setActive(idx) {
  document.querySelectorAll('.community-item').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.idx) === idx);
  });
  currentIdx = idx;
  document.getElementById('prev-btn').style.visibility = idx <= 0 ? 'hidden' : '';
  document.getElementById('next-btn').style.visibility = idx >= PAGES.length - 1 ? 'hidden' : '';
}

function navigate(dir) {
  const next = currentIdx + dir;
  if (next < 0 || next >= PAGES.length) return;
  showCommunity(next);
}

// ── Index view ────────────────────────────────────────────────────────────────

function showIndex() {
  setActive(-1);
  document.getElementById('breadcrumb').textContent = 'All communities';
  document.getElementById('prev-btn').style.visibility = 'hidden';
  document.getElementById('next-btn').style.visibility = 'hidden';
  closeSymPanel();

  const grid = document.createElement('div');
  grid.id = 'index-view';

  PAGES.forEach((page, i) => {
    const card = document.createElement('div');
    card.className = 'index-card';
    card.onclick = () => showCommunity(i);
    const covPct = page.coverage_pct || 0;
    card.innerHTML =
      '<div class="index-card-name">' + escHtml(page.community) + '</div>' +
      '<div class="index-card-desc">' + escHtml(page.description || '') + '</div>' +
      '<div class="index-card-stats">' +
        '<span><span class="stat-value">' + page.symbols.length + '</span> symbols</span>' +
        '<span><span class="stat-value">' + covPct + '%</span> coverage</span>' +
        '<span><span class="stat-value">' + (page.decisions ? page.decisions.length : 0) + '</span> decisions</span>' +
        '<span><span class="stat-value">' + (page.risks ? page.risks.length : 0) + '</span> risks</span>' +
      '</div>';
    grid.appendChild(card);
  });

  const content = document.getElementById('content');
  content.innerHTML = '';
  content.appendChild(grid);
}

// ── Community detail view ─────────────────────────────────────────────────────

function showCommunity(idx) {
  const page = PAGES[idx];
  if (!page) return;
  setActive(idx);
  document.getElementById('breadcrumb').textContent = page.community;
  closeSymPanel();

  const covPct = page.coverage_pct || 0;
  const covClass = covPct >= 70 ? 'high' : covPct >= 30 ? 'mid' : 'low';

  let html =
    '<div class="community-header">' +
      '<h2>' + escHtml(page.community) + '</h2>' +
      '<div class="community-meta">' +
        '<span class="meta-badge">\uD83D\uDCE6 ' + page.symbols.length + ' symbols</span>' +
        '<span class="meta-badge">\uD83D\uDCC1 ' + (page.files ? page.files.length : 0) + ' files</span>' +
        (page.hub_symbol ? '<span class="meta-badge">\u2B50 hub: <code>' + escHtml(page.hub_symbol) + '</code></span>' : '') +
      '</div>' +
      '<div class="coverage-bar">' +
        '<span style="font-size:12px;color:var(--muted)">Test coverage</span>' +
        '<div class="bar-track"><div class="bar-fill ' + covClass + '" style="width:' + covPct + '%"></div></div>' +
        '<span style="font-size:12px;color:var(--muted)">' + covPct + '%</span>' +
      '</div>' +
    '</div>';

  // Decisions
  if (page.decisions && page.decisions.length > 0) {
    html += section('Decisions', page.decisions.length,
      '<div class="record-list">' +
      page.decisions.map(d =>
        '<div class="record-item ' + escHtml(d.confidence) + '">' +
          '<div class="record-title">' + escHtml(d.title || '') + '</div>' +
          '<div class="record-meta">[' + escHtml(d.confidence) + ']</div>' +
        '</div>'
      ).join('') +
      '</div>'
    );
  }

  // Risks
  if (page.risks && page.risks.length > 0) {
    html += section('Risks', page.risks.length,
      '<div class="record-list">' +
      page.risks.map(r =>
        '<div class="record-item risk-' + escHtml(r.severity || 'low') + '">' +
          '<div class="record-title">' +
            (r.severity ? '<span style="text-transform:uppercase;font-size:11px;color:var(--muted)">[' + r.severity + '] </span>' : '') +
            escHtml(r.title || '') +
          '</div>' +
          '<div class="record-meta">' + escHtml(r.confidence) + '</div>' +
        '</div>'
      ).join('') +
      '</div>'
    );
  }

  // Deferred
  if (page.deferred && page.deferred.length > 0) {
    html += section('Open work', page.deferred.length,
      '<div class="record-list">' +
      page.deferred.map(d =>
        '<div class="record-item">' +
          '<div class="record-title">\u23F8 ' + escHtml(d.title || '') + '</div>' +
        '</div>'
      ).join('') +
      '</div>'
    );
  }

  // Symbol table with search
  html += '<div class="section">' +
    '<div class="section-header">Symbols <span class="section-count">' + page.symbols.length + '</span></div>' +
    '<div class="sym-search-wrap"><input class="sym-search" placeholder="Filter symbols..." oninput="filterSymbols(this)"></div>' +
    '<table class="symbol-table" id="sym-table-' + idx + '">' +
      '<thead><tr>' +
        '<th>Symbol</th><th>Kind</th><th>File</th><th>Callers</th><th>Risk</th><th>Exp</th>' +
      '</tr></thead>' +
      '<tbody>' +
      page.symbols.map(s => {
        const riskLevel = s.risk_score >= 70 ? 'critical'
          : s.risk_score >= 45 ? 'high'
          : s.risk_score >= 20 ? 'medium' : 'low';
        return '<tr onclick="showSymbol(' + escAttr(JSON.stringify(s)) + ')" class="sym-row">' +
          '<td><span class="sym-name">' + escHtml(s.name) + '</span></td>' +
          '<td><span class="kind-badge">' + escHtml(s.kind) + '</span></td>' +
          '<td><span class="sym-file">' + escHtml(s.file + ':' + s.line) + '</span></td>' +
          '<td style="text-align:center;font-family:var(--mono);font-size:12px">' + (s.callers ? s.callers.length : 0) + '</td>' +
          '<td><span class="risk-dot risk-' + riskLevel + '"></span></td>' +
          '<td>' + (s.exported ? '<span class="exported-tick">\u2713</span>' : '') + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody>' +
    '</table>' +
  '</div>';

  // Files
  if (page.files && page.files.length > 0) {
    html += section('Files', page.files.length,
      '<div class="file-list">' +
      page.files.map(f => '<div class="file-item">\uD83D\uDCC4 ' + escHtml(f) + '</div>').join('') +
      '</div>'
    );
  }

  document.getElementById('content').innerHTML = html;
}

function section(title, count, body) {
  return '<div class="section">' +
    '<div class="section-header">' + escHtml(title) +
    '<span class="section-count">' + count + '</span></div>' +
    body +
    '</div>';
}

function filterSymbols(input) {
  const q = input.value.toLowerCase();
  document.querySelectorAll('.sym-row').forEach(row => {
    const name = row.querySelector('.sym-name') ? row.querySelector('.sym-name').textContent.toLowerCase() : '';
    const kind = row.querySelector('.kind-badge') ? row.querySelector('.kind-badge').textContent.toLowerCase() : '';
    row.style.display = (name.includes(q) || kind.includes(q)) ? '' : 'none';
  });
}

// ── Symbol detail panel ───────────────────────────────────────────────────────

function showSymbol(sym) {
  const panel = document.getElementById('sym-panel');
  const content = document.getElementById('sym-panel-content');

  const riskLevel = sym.risk_score >= 70 ? 'critical'
    : sym.risk_score >= 45 ? 'high'
    : sym.risk_score >= 20 ? 'medium' : 'low';

  let html =
    '<div class="sym-panel-name">' + escHtml(sym.name) + '</div>' +
    '<div class="sym-panel-file">' + escHtml(sym.file + ':' + sym.line) + '</div>';

  html +=
    '<div class="sym-panel-section">' +
      '<div class="sym-panel-label">Details</div>' +
      '<div style="font-size:13px;color:var(--muted);display:flex;flex-direction:column;gap:4px">' +
        '<span>Kind: <span style="color:var(--text)">' + escHtml(sym.kind) + '</span></span>' +
        '<span>Exported: <span style="color:var(--text)">' + (sym.exported ? 'yes' : 'no') + '</span></span>' +
        '<span>Test: <span style="color:var(--text)">' + (sym.is_test ? 'yes' : 'no') + '</span></span>' +
        '<span>Risk score: <span class="risk-dot risk-' + riskLevel + '" style="margin-right:4px"></span>' +
          '<span style="color:var(--text)">' + sym.risk_score + ' (' + riskLevel + ')</span></span>' +
        '<span>Reasoning: <span style="color:var(--text)">' + (sym.has_reasoning ? '\u2713 has reasoning' : 'none') + '</span></span>' +
      '</div>' +
    '</div>';

  if (sym.callers && sym.callers.length > 0) {
    html +=
      '<div class="sym-panel-section">' +
        '<div class="sym-panel-label">Called by (' + sym.callers.length + ')</div>' +
        sym.callers.map(c =>
          '<span class="caller-chip" onclick="findSymbol(' + escAttr(JSON.stringify(c)) + ')">' + escHtml(c) + '</span>'
        ).join('') +
      '</div>';
  }

  if (sym.callees && sym.callees.length > 0) {
    html +=
      '<div class="sym-panel-section">' +
        '<div class="sym-panel-label">Calls (' + sym.callees.length + ')</div>' +
        sym.callees.map(c =>
          '<span class="caller-chip">' + escHtml(c) + '</span>'
        ).join('') +
      '</div>';
  }

  content.innerHTML = html;
  panel.classList.add('open');
}

function closeSymPanel() {
  document.getElementById('sym-panel').classList.remove('open');
}

function findSymbol(name) {
  for (let i = 0; i < PAGES.length; i++) {
    const sym = PAGES[i].symbols.find(s => s.name === name);
    if (sym) {
      showCommunity(i);
      setTimeout(() => showSymbol(sym), 100);
      return;
    }
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  if (!str) return '""';
  return '"' + String(str)
    .replace(/\\\\/g, '\\\\\\\\')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;') + '"';
}

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSymPanel();
  if (e.key === 'ArrowLeft'  && currentIdx >= 0) navigate(-1);
  if (e.key === 'ArrowRight' && currentIdx >= 0) navigate(1);
});

boot();
</script>
</body>
</html>`;
}
