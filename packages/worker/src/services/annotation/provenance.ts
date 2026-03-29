import Anthropic from "@anthropic-ai/sdk";
import { sessionsDb } from "../sqlite/db.js";
import { getReasoningData } from "../reasoning/service.js";

export interface ProvenanceEvent {
  timestamp: number;
  type: "session" | "decision" | "risk" | "deferred" | "confirmed" | "template" | "adr";
  title: string;
  detail: string;
  actor: string;     // author email, "ai-compression", or "bootstrap:<template>"
  record_id?: string;
  confidence: string;
}

export interface ProvenanceTrace {
  symbol: string;
  repo: string;
  generated: number;
  timeline: ProvenanceEvent[];
  summary: string;
  open_items: string[];
}

// ---------------------------------------------------------------------------
// buildProvenance — assemble full chronological event list for a symbol
// ---------------------------------------------------------------------------

export async function buildProvenance(symbol: string, repo: string): Promise<ProvenanceTrace> {
  const events: ProvenanceEvent[] = [];

  // 1. Sessions whose summary mentions this symbol
  const sessionRes = await sessionsDb.execute({
    sql: `SELECT id, summary, started_at, ended_at FROM sessions
          WHERE repo = ? AND summary LIKE ? AND status = 'complete'
          ORDER BY started_at ASC`,
    args: [repo, `%${symbol}%`],
  });

  for (const row of sessionRes.rows) {
    const r = row as Record<string, unknown>;
    const ts = Number(r["ended_at"] ?? r["started_at"] ?? 0);
    const summary = String(r["summary"] ?? "");
    events.push({
      timestamp: ts,
      type: "session",
      title: `Session: ${summary.slice(0, 60)}${summary.length > 60 ? "..." : ""}`,
      detail: summary,
      actor: "ai-compression",
      record_id: String(r["id"] ?? ""),
      confidence: "extracted",
    });
  }

  // 2. Reasoning records anchored to this symbol
  const data = await getReasoningData(symbol, repo);

  for (const d of data.decisions as Record<string, unknown>[]) {
    const source = String(d["source"] ?? "");
    const isTemplate = source.startsWith("template:");
    const isAdr = d["adr_status"] != null;
    const content = String(d["content"] ?? "");
    const ts = Number(d["created_at"] ?? 0);

    events.push({
      timestamp: ts,
      type: isAdr ? "adr" : isTemplate ? "template" : "decision",
      title: isTemplate
        ? `Bootstrap: ${source}`
        : `Decision: ${content.slice(0, 60)}${content.length > 60 ? "..." : ""}`,
      detail: content,
      actor: isTemplate ? source : "ai-compression",
      record_id: String(d["id"] ?? ""),
      confidence: String(d["confidence"] ?? "extracted"),
    });

    // Confirmation event — sits 1ms after creation to order after the extract event
    if (String(d["confidence"]) === "confirmed" && d["confirmed_by"]) {
      events.push({
        timestamp: ts + 1,
        type: "confirmed",
        title: `Confirmed: ${content.slice(0, 50)}`,
        detail: `Confirmed by ${String(d["confirmed_by"])}`,
        actor: String(d["confirmed_by"]),
        record_id: String(d["id"] ?? ""),
        confidence: "confirmed",
      });
    }
  }

  for (const r of data.risks as Record<string, unknown>[]) {
    const source = String(r["source"] ?? "");
    const isTemplate = source.startsWith("template:");
    const content = String(r["content"] ?? "");
    const ts = Number(r["created_at"] ?? 0);

    events.push({
      timestamp: ts,
      type: isTemplate ? "template" : "risk",
      title: `Risk: ${content.slice(0, 60)}${content.length > 60 ? "..." : ""}`,
      detail: content,
      actor: isTemplate ? source : "ai-compression",
      record_id: String(r["id"] ?? ""),
      confidence: String(r["confidence"] ?? "extracted"),
    });

    if (String(r["confidence"]) === "confirmed" && r["confirmed_by"]) {
      events.push({
        timestamp: ts + 1,
        type: "confirmed",
        title: `Confirmed risk: ${content.slice(0, 50)}`,
        detail: `Confirmed by ${String(r["confirmed_by"])}`,
        actor: String(r["confirmed_by"]),
        record_id: String(r["id"] ?? ""),
        confidence: "confirmed",
      });
    }
  }

  for (const dw of data.deferred as Record<string, unknown>[]) {
    const content = String(dw["content"] ?? "");
    events.push({
      timestamp: Number(dw["created_at"] ?? 0),
      type: "deferred",
      title: `Deferred: ${content.slice(0, 60)}${content.length > 60 ? "..." : ""}`,
      detail: content,
      actor: "ai-compression",
      record_id: String(dw["id"] ?? ""),
      confidence: String(dw["confidence"] ?? "extracted"),
    });
  }

  events.sort((a, b) => a.timestamp - b.timestamp);

  // 3. Open deferred items — compute days open
  const open_items = (data.deferred as Record<string, unknown>[]).map((dw) => {
    const content = String(dw["content"] ?? "");
    const createdAt = Number(dw["created_at"] ?? 0);
    const daysOpen = Math.floor((Date.now() - createdAt) / (1000 * 60 * 60 * 24));
    const blockedBy = dw["blocked_by"] ? ` (blocked: ${String(dw["blocked_by"])})` : "";
    return `${content.slice(0, 100)}${blockedBy} — ${daysOpen} days open`;
  });

  // 4. AI-generated summary
  let summary = `No recorded history for ${symbol} in ${repo}.`;
  if (events.length > 0) {
    try {
      const client = new Anthropic();
      const eventSummary = events
        .slice(-10)
        .map(
          (e) =>
            `[${new Date(e.timestamp).toISOString().slice(0, 10)}] ${e.type}: ${e.title}`,
        )
        .join("\n");

      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content:
              `In 3 sentences, summarise the decision history of the symbol "${symbol}" ` +
              `based on these events:\n${eventSummary}\n\n` +
              `Focus on why it exists in its current form and what constraints apply.`,
          },
        ],
      });

      const block = response.content[0];
      if (block && block.type === "text") {
        summary = block.text.trim();
      }
    } catch {
      summary =
        `${symbol} has ${events.length} recorded event(s) spanning decisions, ` +
        `risks, and sessions. See timeline for details.`;
    }
  }

  return { symbol, repo, generated: Date.now(), timeline: events, summary, open_items };
}

// ---------------------------------------------------------------------------
// Text renderer
// ---------------------------------------------------------------------------

export function formatProvenanceText(trace: ProvenanceTrace): string {
  const lines: string[] = [];
  lines.push(`Provenance trace: ${trace.symbol} — ${trace.repo}`);
  lines.push(`Generated: ${new Date(trace.generated).toISOString().slice(0, 10)}`);
  lines.push("");
  lines.push("TIMELINE");
  lines.push("━━━━━━━━");

  for (const event of trace.timeline) {
    const date = new Date(event.timestamp).toISOString().slice(0, 10);
    lines.push(`\n${date}  ${event.type.toUpperCase()}`);
    lines.push(`            ${event.title}`);
    if (event.actor !== "ai-compression") {
      lines.push(`            Actor: ${event.actor}`);
    }
    if (event.detail && event.detail !== event.title) {
      const snippet = event.detail.length > 200
        ? event.detail.slice(0, 197) + "..."
        : event.detail;
      lines.push(`            ${snippet}`);
    }
    if (event.record_id) {
      lines.push(`            [${event.confidence}] id: ${event.record_id}`);
    }
  }

  lines.push("");
  lines.push("SUMMARY");
  lines.push("━━━━━━━");
  lines.push(trace.summary);

  if (trace.open_items.length > 0) {
    lines.push("");
    lines.push("OPEN ITEMS");
    lines.push("━━━━━━━━━━");
    for (const item of trace.open_items) {
      lines.push(`• ${item}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Mermaid renderer
// ---------------------------------------------------------------------------

export function formatProvenanceMermaid(trace: ProvenanceTrace): string {
  const lines: string[] = [];
  lines.push("%%{init: {'theme': 'base'}}%%");
  lines.push("timeline");
  lines.push(`  title ${trace.symbol} provenance`);

  // Group events by date
  const byDate = new Map<string, ProvenanceEvent[]>();
  for (const event of trace.timeline) {
    const date = new Date(event.timestamp).toISOString().slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(event);
  }

  for (const [date, evts] of byDate) {
    const [first, ...rest] = evts;
    if (!first) continue;
    lines.push(`  ${date} : ${first.title.slice(0, 50)}`);
    for (const e of rest) {
      lines.push(`           : ${e.title.slice(0, 50)}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTML renderer
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const TYPE_COLOR: Record<string, string> = {
  session: "#3b82f6",
  decision: "#10b981",
  risk: "#ef4444",
  deferred: "#f59e0b",
  confirmed: "#6366f1",
  template: "#8b5cf6",
  adr: "#06b6d4",
};

export function formatProvenanceHtml(trace: ProvenanceTrace): string {
  const eventsHtml = trace.timeline
    .map((event) => {
      const date = new Date(event.timestamp).toISOString().slice(0, 10);
      const color = TYPE_COLOR[event.type] ?? "#6b7280";
      return `<div class="event" data-type="${esc(event.type)}">
  <div class="event-header">
    <span class="event-dot" style="background:${color}"></span>
    <span class="event-date">${date}</span>
    <span class="event-type" style="color:${color}">${esc(event.type.toUpperCase())}</span>
    <span class="event-title">${esc(event.title)}</span>
  </div>
  <div class="event-detail">
    <div class="event-body">${esc(event.detail)}</div>
    <div class="event-meta">
      <span class="confidence confidence-${esc(event.confidence)}">${esc(event.confidence)}</span>
      ${event.actor !== "ai-compression" ? `<span class="actor">by ${esc(event.actor)}</span>` : ""}
      ${event.record_id ? `<span class="record-id">id: ${esc(event.record_id)}</span>` : ""}
    </div>
  </div>
</div>`;
    })
    .join("\n");

  const openItemsHtml =
    trace.open_items.length > 0
      ? `<div class="open-items">
<h3>Open Items</h3>
<ul>${trace.open_items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>
</div>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(trace.symbol)} — Provenance Trace</title>
<style>
:root{--bg:#0f172a;--surface:#1e293b;--border:#334155;--text:#e2e8f0;--muted:#94a3b8;--accent:#3b82f6}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:ui-monospace,monospace;padding:2rem;max-width:900px;margin:0 auto}
h1{font-size:1.25rem;color:var(--accent);margin-bottom:.5rem}
.meta{color:var(--muted);font-size:.8rem;margin-bottom:2rem}
.summary{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1rem;margin-bottom:2rem;line-height:1.6}
.timeline{position:relative;padding-left:1.5rem}
.timeline::before{content:"";position:absolute;left:.5rem;top:0;bottom:0;width:2px;background:var(--border)}
.event{position:relative;margin-bottom:1.5rem}
.event-header{display:flex;align-items:center;gap:.75rem;cursor:pointer;user-select:none}
.event-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;position:absolute;left:-1.15rem;top:.25rem}
.event-date{color:var(--muted);font-size:.75rem;white-space:nowrap}
.event-type{font-size:.65rem;font-weight:bold;letter-spacing:.05em}
.event-title{font-size:.875rem}
.event-detail{margin-top:.5rem;margin-left:.75rem;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:.75rem;display:none}
.event.expanded .event-detail{display:block}
.event-body{font-size:.8rem;line-height:1.5;margin-bottom:.5rem}
.event-meta{display:flex;gap:1rem;flex-wrap:wrap}
.confidence{font-size:.65rem;padding:2px 6px;border-radius:3px}
.confidence-confirmed{background:#166534;color:#bbf7d0}
.confidence-extracted{background:#1e3a5f;color:#bfdbfe}
.confidence-inferred{background:#3b1f6e;color:#ddd6fe}
.actor,.record-id{font-size:.7rem;color:var(--muted)}
.open-items{margin-top:2rem;background:var(--surface);border:1px solid #854d0e;border-radius:8px;padding:1rem}
.open-items h3{color:#fbbf24;margin-bottom:.75rem;font-size:.875rem}
.open-items li{font-size:.8rem;margin-bottom:.25rem;color:var(--muted)}
h2{font-size:.9rem;color:var(--muted);letter-spacing:.1em;margin:1.5rem 0 1rem;text-transform:uppercase}
</style>
</head>
<body>
<h1>${esc(trace.symbol)} — Provenance Trace</h1>
<div class="meta">Repo: ${esc(trace.repo)} &middot; ${trace.timeline.length} events &middot; Generated: ${new Date(trace.generated).toISOString().slice(0, 10)}</div>
<div class="summary">${esc(trace.summary)}</div>
${openItemsHtml}
<h2>Timeline</h2>
<div class="timeline">
${eventsHtml}
</div>
<script>
document.querySelectorAll('.event-header').forEach(h=>{
  h.addEventListener('click',()=>h.closest('.event').classList.toggle('expanded'));
});
</script>
</body>
</html>`;
}
