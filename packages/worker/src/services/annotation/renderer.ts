import { extname } from "path";
import type { Annotation } from "./mapper.js";

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function detectLanguage(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".py":
      return "python";
    case ".go":
      return "go";
    default:
      return "plaintext";
  }
}

interface LineStyle {
  border: string;
  indicator: string;
}

function lineStyle(records: Annotation["records"]): LineStyle {
  const hasCritical = records.some(
    (r) => r.type === "risk" && ["critical", "high"].includes(r.severity ?? ""),
  );
  const hasRisk = records.some((r) => r.type === "risk");
  const hasConfirmedDecision = records.some(
    (r) => r.type === "decision" && r.confidence === "confirmed",
  );
  const hasDecision = records.some((r) => r.type === "decision");
  const hasDeferred = records.some((r) => r.type === "deferred");

  if (hasCritical || hasRisk) return { border: "#ef4444", indicator: "⚠" };
  if (hasConfirmedDecision) return { border: "#3b82f6", indicator: "●" };
  if (hasDecision) return { border: "#f59e0b", indicator: "●" };
  if (hasDeferred) return { border: "#fbbf24", indicator: "◎" };
  return { border: "#6b7280", indicator: "⌚" };
}

// ---------------------------------------------------------------------------
// renderAnnotatedSource — self-contained HTML page
// ---------------------------------------------------------------------------

export function renderAnnotatedSource(
  filePath: string,
  fileContent: string,
  annotations: Annotation[],
  repo: string,
): string {
  const language = detectLanguage(filePath);
  const lines = fileContent.split("\n");
  const fileName = filePath.split("/").pop() ?? filePath;
  const lastIndexed = new Date().toISOString().slice(0, 10);

  const annoByLine = new Map<number, Annotation>();
  for (const anno of annotations) annoByLine.set(anno.line, anno);

  const annotatedSymbols = new Set(annotations.map((a) => a.symbol));
  const totalSymbolsEstimate = annotatedSymbols.size; // approximate — mapper knows actual count

  // Serialise annotation data for the JS runtime
  const panelData: Record<number, unknown> = {};
  for (const anno of annotations) panelData[anno.line] = anno;

  // Per-line HTML used as fallback when JS hasn't run yet
  // (also read by rebuildLines() to attach event listeners)
  const linesJson = JSON.stringify(lines);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(fileName)} — claude-lore annotation</title>
<link rel="stylesheet"
  href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/typescript.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/go.min.js"></script>
<style>
:root{--bg:#0f172a;--surface:#1e293b;--border:#334155;--text:#e2e8f0;--muted:#94a3b8;--accent:#3b82f6}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:ui-monospace,'Cascadia Code',monospace;font-size:13px;height:100vh;display:flex;flex-direction:column;overflow:hidden}
.file-header{background:var(--surface);border-bottom:1px solid var(--border);padding:.75rem 1.25rem;flex-shrink:0}
.file-header .title{font-weight:bold;color:var(--accent);font-size:.9rem}
.file-header .meta{color:var(--muted);font-size:.72rem;margin-top:.2rem}
.main{display:flex;flex:1;overflow:hidden}
.source-pane{flex:1;overflow:auto;background:var(--bg)}
.panel-pane{width:30%;min-width:260px;max-width:420px;background:var(--surface);border-left:1px solid var(--border);overflow-y:auto;padding:1rem;flex-shrink:0}
/* Line rendering */
.line{display:flex;align-items:flex-start;min-height:1.5em;border-left:3px solid transparent}
.line:hover{background:rgba(255,255,255,.03)}
.line.annotated:hover{background:rgba(255,255,255,.06)}
.line.active{background:rgba(59,130,246,.1)}
.ln{width:3.2em;text-align:right;color:var(--muted);padding:0 .6rem;flex-shrink:0;user-select:none;font-size:.72rem;padding-top:3px}
.ann-ind{width:1.4em;text-align:center;flex-shrink:0;font-size:.7rem;padding-top:2px}
.line-code{white-space:pre;flex:1;padding-right:1rem;line-height:1.55;tab-size:2}
/* Panel */
.panel-empty{color:var(--muted);font-size:.8rem;padding:.5rem 0}
.panel-symbol{font-weight:bold;color:var(--accent);margin-bottom:.2rem}
.panel-line-num{color:var(--muted);font-size:.72rem;margin-bottom:1rem}
.p-section{margin-bottom:1.25rem}
.p-section-title{font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:.5rem;border-bottom:1px solid var(--border);padding-bottom:.25rem}
.rec-card{background:var(--bg);border-radius:6px;padding:.65rem;margin-bottom:.45rem;border:1px solid var(--border);cursor:pointer}
.rec-conf{font-size:.62rem;padding:2px 5px;border-radius:3px;margin-bottom:.4rem;display:inline-block}
.conf-confirmed{background:#166534;color:#bbf7d0}
.conf-extracted{background:#1e3a5f;color:#bfdbfe}
.conf-inferred{background:#3b1f6e;color:#ddd6fe}
.conf-contested{background:#7c2d12;color:#fed7aa}
.rec-sev{font-size:.62rem;padding:1px 4px;border-radius:3px;margin-left:3px;vertical-align:middle}
.sev-critical,.sev-high{background:#7f1d1d;color:#fca5a5}
.sev-medium{background:#78350f;color:#fcd34d}
.sev-low{background:#1c3a1c;color:#86efac}
.rec-title{font-size:.78rem;font-weight:bold;margin-bottom:.3rem}
.rec-summary{font-size:.73rem;color:var(--muted);line-height:1.5}
.rec-full{font-size:.73rem;color:var(--text);line-height:1.5;display:none;margin-top:.3rem}
.rec-card.expanded .rec-summary{display:none}
.rec-card.expanded .rec-full{display:block}
.rec-chain{font-size:.68rem;color:var(--muted);margin-top:.35rem}
/* Footer */
.footer{background:var(--surface);border-top:1px solid var(--border);padding:.35rem 1.25rem;display:flex;gap:1.25rem;flex-shrink:0;font-size:.68rem;color:var(--muted);flex-wrap:wrap}
.leg{display:flex;align-items:center;gap:.25rem}
</style>
</head>
<body>

<div class="file-header">
  <div class="title">${esc(fileName)} — claude-lore knowledge graph annotation</div>
  <div class="meta">Repo: ${esc(repo)} &middot; Annotated symbols: ${annotatedSymbols.size} &middot; Last indexed: ${lastIndexed}</div>
</div>

<div class="main">
  <div class="source-pane" id="sourcePane"></div>
  <div class="panel-pane" id="panel">
    <div class="panel-empty">Click a highlighted line to see reasoning records.</div>
  </div>
</div>

<div class="footer">
  <div class="leg"><span style="color:#3b82f6">●</span> Confirmed decision</div>
  <div class="leg"><span style="color:#f59e0b">●</span> Extracted decision</div>
  <div class="leg"><span style="color:#ef4444">⚠</span> High/critical risk</div>
  <div class="leg"><span style="color:#fbbf24">◎</span> Open deferred</div>
  <div class="leg"><span style="color:#6b7280">⌚</span> Session history only</div>
</div>

<script>
/* ---- data ---- */
const ANNOTATIONS = ${JSON.stringify(panelData)};
const LINES = ${linesJson};
const LANGUAGE = ${JSON.stringify(language)};

/* ---- helpers ---- */
function e(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function confCls(c){
  if(c==='confirmed') return 'conf-confirmed';
  if(c==='inferred') return 'conf-inferred';
  if(c==='contested') return 'conf-contested';
  return 'conf-extracted';
}
function lineColor(records){
  const hasRisk = records.some(r=>r.type==='risk'&&['critical','high'].includes(r.severity||''));
  const anyRisk = records.some(r=>r.type==='risk');
  const confDec = records.some(r=>r.type==='decision'&&r.confidence==='confirmed');
  const anyDec  = records.some(r=>r.type==='decision');
  const def     = records.some(r=>r.type==='deferred');
  if(hasRisk||anyRisk) return {c:'#ef4444',i:'⚠'};
  if(confDec)          return {c:'#3b82f6',i:'●'};
  if(anyDec)           return {c:'#f59e0b',i:'●'};
  if(def)              return {c:'#fbbf24',i:'◎'};
  return {c:'#6b7280',i:'⌚'};
}

/* ---- syntax highlighting on demand ---- */
function hlLine(text){
  if(LANGUAGE==='plaintext') return e(text);
  try{
    const r = hljs.highlight(text,{language:LANGUAGE,ignoreIllegals:true});
    return r.value;
  }catch{return e(text);}
}

/* ---- render panel ---- */
function renderPanel(anno){
  const panel = document.getElementById('panel');
  if(!anno){
    panel.innerHTML='<div class="panel-empty">No reasoning records for this line.</div>';
    return;
  }
  const recs = anno.records||[];
  const sections = [
    {label:'DECISIONS',  items:recs.filter(r=>r.type==='decision')},
    {label:'RISKS',      items:recs.filter(r=>r.type==='risk')},
    {label:'DEFERRED',   items:recs.filter(r=>r.type==='deferred')},
    {label:'SESSION HISTORY', items:recs.filter(r=>r.type==='session')},
  ];
  let html='<div class="panel-symbol">'+e(anno.symbol)+'</div>';
  html+='<div class="panel-line-num">line '+anno.line+'</div>';
  for(const sec of sections){
    if(!sec.items.length) continue;
    html+='<div class="p-section"><div class="p-section-title">'+e(sec.label)+'</div>';
    for(const r of sec.items){
      const sev = r.severity ? '<span class="rec-sev sev-'+e(r.severity)+'">'+e(r.severity.toUpperCase())+'</span>' : '';
      const chain = r.chain&&r.chain.length>1 ? '<div class="rec-chain">Provenance: '+r.chain.length+' records</div>' : '';
      html+='<div class="rec-card" onclick="this.classList.toggle(\'expanded\')">'
        +'<span class="rec-conf '+confCls(r.confidence)+'">'+e(r.confidence)+'</span>'+sev
        +'<div class="rec-title">'+e(r.title)+'</div>'
        +'<div class="rec-summary">'+e(r.summary)+'</div>'
        +'<div class="rec-full">'+e(r.full)+'</div>'
        +chain
        +'</div>';
    }
    html+='</div>';
  }
  panel.innerHTML = html;
}

/* ---- build source pane ---- */
(function buildPane(){
  const pane = document.getElementById('sourcePane');
  const frag = document.createDocumentFragment();
  LINES.forEach((text, idx)=>{
    const num = idx+1;
    const anno = ANNOTATIONS[num];
    const div = document.createElement('div');
    div.className = 'line'+(anno?' annotated':'');
    div.dataset.line = num;
    if(anno){
      const {c,i} = lineColor(anno.records);
      div.style.borderLeftColor = c;
      div.style.cursor = 'pointer';
      div.addEventListener('click',()=>{
        document.querySelectorAll('.line.active').forEach(el=>el.classList.remove('active'));
        div.classList.add('active');
        renderPanel(anno);
      });
      div.innerHTML = '<span class="ln">'+num+'</span>'
        +'<span class="ann-ind" style="color:'+c+'">'+i+'</span>'
        +'<span class="line-code">'+hlLine(text)+'</span>';
    } else {
      div.style.borderLeftColor = 'transparent';
      div.innerHTML = '<span class="ln">'+num+'</span>'
        +'<span class="ann-ind"></span>'
        +'<span class="line-code">'+hlLine(text)+'</span>';
    }
    frag.appendChild(div);
  });
  pane.appendChild(frag);
})();
</script>
</body>
</html>`;
}
