import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { sessionsDb } from "../../sqlite/db.js";

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  lines_added: number;
  lines_removed: number;
  patch: string;
}

export interface ReasoningRecord {
  id: string;
  type: string;
  content: string;
  confidence: string;
  symbol?: string;
  created_at: number;
}

export interface FileReview {
  file: DiffFile;
  records: ReasoningRecord[];
  warnings: string[];  // flagged concerns based on record content
}

// ---------------------------------------------------------------------------
// Git diff extraction
// ---------------------------------------------------------------------------

export function getGitDiff(cwd: string, base?: string): DiffFile[] {
  if (!existsSync(join(cwd, ".git"))) {
    return [];
  }

  const baseRef = base ?? "HEAD";
  const files: DiffFile[] = [];

  try {
    // Get list of changed files with status
    const nameStatus = execSync(
      `git -C "${cwd}" diff --name-status ${baseRef}`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();

    if (!nameStatus) return [];

    for (const line of nameStatus.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const status = parts[0]?.[0] ?? "M";
      const filePath = parts[1] ?? "";

      const statusMap: Record<string, DiffFile["status"]> = {
        A: "added", M: "modified", D: "deleted", R: "renamed",
      };

      // Get patch for this file
      let patch = "";
      try {
        patch = execSync(
          `git -C "${cwd}" diff ${baseRef} -- "${filePath}"`,
          { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1024 * 1024 },
        );
      } catch { /* ok */ }

      // Count lines
      const added = (patch.match(/^\+[^+]/gm) ?? []).length;
      const removed = (patch.match(/^-[^-]/gm) ?? []).length;

      files.push({
        path: filePath,
        status: statusMap[status] ?? "modified",
        lines_added: added,
        lines_removed: removed,
        patch,
      });
    }
  } catch {
    // git not available or not a git repo
  }

  return files;
}

// ---------------------------------------------------------------------------
// Reasoning lookup per changed file
// ---------------------------------------------------------------------------

async function getRecordsForFile(
  filePath: string,
  repo: string,
): Promise<ReasoningRecord[]> {
  const fileBase = filePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";

  try {
    const [decisions, risks, deferred] = await Promise.all([
      sessionsDb.execute({
        sql: `SELECT id, 'decision' as type, content, confidence, symbol, created_at
              FROM decisions WHERE repo = ?
              AND (content LIKE ? OR symbol LIKE ?)
              ORDER BY created_at DESC LIMIT 10`,
        args: [repo, `%${fileBase}%`, `%${fileBase}%`],
      }),
      sessionsDb.execute({
        sql: `SELECT id, 'risk' as type, content, confidence, symbol, created_at
              FROM risks WHERE repo = ?
              AND (content LIKE ? OR symbol LIKE ?)
              ORDER BY created_at DESC LIMIT 10`,
        args: [repo, `%${fileBase}%`, `%${fileBase}%`],
      }),
      sessionsDb.execute({
        sql: `SELECT id, 'deferred_work' as type, content, confidence, symbol, created_at
              FROM deferred_work WHERE repo = ? AND status = 'open'
              AND (content LIKE ? OR symbol LIKE ?)
              ORDER BY created_at DESC LIMIT 5`,
        args: [repo, `%${fileBase}%`, `%${fileBase}%`],
      }),
    ]);

    const toRecord = (row: Record<string, unknown>): ReasoningRecord => ({
      id: String(row["id"] ?? ""),
      type: String(row["type"] ?? ""),
      content: String(row["content"] ?? ""),
      confidence: String(row["confidence"] ?? "extracted"),
      symbol: row["symbol"] ? String(row["symbol"]) : undefined,
      created_at: Number(row["created_at"] ?? 0),
    });

    return [
      ...decisions.rows.map(toRecord),
      ...risks.rows.map(toRecord),
      ...deferred.rows.map(toRecord),
    ];
  } catch {
    return [];
  }
}

function computeWarnings(file: DiffFile, records: ReasoningRecord[]): string[] {
  const warnings: string[] = [];

  const risks = records.filter((r) => r.type === "risk");
  if (risks.length > 0) {
    warnings.push(`${risks.length} risk record(s) associated with this file — review before merging`);
  }

  const deferred = records.filter((r) => r.type === "deferred_work");
  if (deferred.length > 0) {
    warnings.push(`${deferred.length} open deferred item(s) mention this file`);
  }

  // Heuristic: large change to a file with decisions — could violate constraints
  if (file.lines_added + file.lines_removed > 50 && records.filter((r) => r.type === "decision").length > 0) {
    warnings.push("Large change to a file with architectural decisions — verify constraints are still met");
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Review builder
// ---------------------------------------------------------------------------

export async function buildReview(
  cwd: string,
  repo: string,
  base?: string,
): Promise<FileReview[]> {
  const diffs = getGitDiff(cwd, base);

  const reviews = await Promise.all(
    diffs.map(async (file) => {
      const records = await getRecordsForFile(file.path, repo);
      const warnings = computeWarnings(file, records);
      return { file, records, warnings };
    }),
  );

  return reviews;
}

// ---------------------------------------------------------------------------
// HTML renderer
// ---------------------------------------------------------------------------

function renderPatch(patch: string): string {
  const lines = patch.split("\n").slice(0, 80); // cap display
  return lines
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) {
        return `<span class="diff-meta">${escHtml(line)}</span>`;
      }
      if (line.startsWith("@@")) {
        return `<span class="diff-hunk">${escHtml(line)}</span>`;
      }
      if (line.startsWith("+")) {
        return `<span class="diff-add">${escHtml(line)}</span>`;
      }
      if (line.startsWith("-")) {
        return `<span class="diff-del">${escHtml(line)}</span>`;
      }
      return `<span class="diff-ctx">${escHtml(line)}</span>`;
    })
    .join("\n");
}

function renderRecord(r: ReasoningRecord): string {
  const typeLabel = r.type === "decision" ? "DECISION" : r.type === "risk" ? "RISK" : "DEFERRED";
  const typeClass = r.type === "decision" ? "rec-decision" : r.type === "risk" ? "rec-risk" : "rec-deferred";
  const confClass = r.confidence === "confirmed" ? "conf-confirmed" : r.confidence === "inferred" ? "conf-inferred" : "conf-extracted";
  const preview = r.content.slice(0, 200) + (r.content.length > 200 ? "…" : "");
  return `<div class="record ${typeClass}">
    <div class="rec-header">
      <span class="rec-type">${typeLabel}</span>
      <span class="rec-conf ${confClass}">${r.confidence}</span>
      ${r.symbol ? `<span class="rec-symbol">${escHtml(r.symbol)}</span>` : ""}
      <span class="rec-id">${escHtml(r.id)}</span>
    </div>
    <div class="rec-body">${escHtml(preview)}</div>
  </div>`;
}

export function renderReviewHtml(
  reviews: FileReview[],
  cwd: string,
  base: string,
): string {
  const totalFiles = reviews.length;
  const withWarnings = reviews.filter((r) => r.warnings.length > 0).length;
  const totalRecords = reviews.reduce((a, r) => a + r.records.length, 0);

  const filesHtml = reviews
    .map((review, idx) => {
      const { file, records, warnings } = review;
      const statusClass = file.status === "added" ? "status-added"
        : file.status === "deleted" ? "status-deleted" : "status-modified";

      return `<section class="file-section${warnings.length > 0 ? " has-warnings" : ""}" id="file-${idx}">
  <div class="file-header" onclick="toggleFile(${idx})">
    <span class="chevron" id="chev-${idx}">▼</span>
    <span class="status-badge ${statusClass}">${file.status.toUpperCase()}</span>
    <span class="file-name">${escHtml(file.path)}</span>
    <span class="line-counts">+${file.lines_added} -${file.lines_removed}</span>
    ${warnings.length > 0 ? `<span class="warn-badge">⚠ ${warnings.length}</span>` : ""}
    ${records.length > 0 ? `<span class="rec-badge">${records.length} records</span>` : ""}
  </div>
  <div class="file-body" id="body-${idx}">
    ${warnings.length > 0 ? `<div class="warnings-box">${warnings.map((w) => `<div class="warning-item">⚠ ${escHtml(w)}</div>`).join("")}</div>` : ""}
    ${records.length > 0 ? `<div class="records-section"><div class="records-label">Reasoning records</div>${records.map(renderRecord).join("")}</div>` : ""}
    <div class="patch-section">
      <div class="patch-label">Diff</div>
      <pre class="patch-pre"><code>${renderPatch(file.patch)}</code></pre>
    </div>
  </div>
</section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Pre-commit Review</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#f1f5f9;min-height:100vh}
#header{background:#1e293b;border-bottom:1px solid #334155;padding:12px 20px;position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:16px}
#header h1{font-size:15px;font-weight:700;flex:1}
.summary-pill{background:#334155;border-radius:10px;padding:3px 10px;font-size:11px;color:#94a3b8;white-space:nowrap}
.summary-pill.warn{background:#422006;color:#fbbf24}
#content{max-width:960px;margin:0 auto;padding:16px}
.base-row{font-size:11px;color:#64748b;margin-bottom:14px;font-family:monospace}
.file-section{background:#1e293b;border:1px solid #334155;border-radius:8px;margin-bottom:10px;overflow:hidden}
.file-section.has-warnings{border-color:#f59e0b}
.file-header{padding:10px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;user-select:none}
.file-header:hover{background:#334155}
.chevron{font-size:10px;color:#64748b;transition:transform 0.2s;flex-shrink:0}
.chevron.closed{transform:rotate(-90deg)}
.status-badge{font-size:9px;font-weight:700;padding:1px 6px;border-radius:4px;flex-shrink:0}
.status-added{background:#d1fae5;color:#065f46}
.status-modified{background:#dbeafe;color:#1e40af}
.status-deleted{background:#fee2e2;color:#991b1b}
.file-name{font-size:12px;font-family:monospace;color:#e2e8f0;flex:1;word-break:break-all}
.line-counts{font-size:11px;font-family:monospace;color:#64748b;white-space:nowrap}
.warn-badge{background:#422006;color:#fbbf24;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:600;flex-shrink:0}
.rec-badge{background:#1e3a5f;color:#93c5fd;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:600;flex-shrink:0}
.file-body{border-top:1px solid #334155}
.warnings-box{background:#1c1007;border-bottom:1px solid #334155;padding:10px 14px}
.warning-item{font-size:12px;color:#fbbf24;padding:3px 0}
.records-section{border-bottom:1px solid #334155;padding:10px 14px}
.records-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#64748b;margin-bottom:8px}
.record{background:#0f172a;border:1px solid #334155;border-radius:6px;margin-bottom:6px;padding:8px 10px}
.rec-header{display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap}
.rec-type{font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px}
.rec-decision .rec-type{background:#1e3a5f;color:#93c5fd}
.rec-risk .rec-type{background:#450a0a;color:#fca5a5}
.rec-deferred .rec-type{background:#422006;color:#fde68a}
.rec-conf{font-size:9px;padding:1px 5px;border-radius:3px}
.conf-confirmed{background:#d1fae5;color:#065f46}
.conf-extracted{background:#fef3c7;color:#92400e}
.conf-inferred{background:#f3f4f6;color:#374151}
.rec-symbol{font-size:10px;font-family:monospace;color:#94a3b8}
.rec-id{font-size:9px;color:#475569;font-family:monospace;margin-left:auto}
.rec-body{font-size:12px;color:#94a3b8;line-height:1.5}
.patch-section{padding:10px 14px}
.patch-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#64748b;margin-bottom:6px}
.patch-pre{background:#0a0f1a;border:1px solid #334155;border-radius:4px;padding:10px 12px;overflow-x:auto;font-size:11px;line-height:1.5;font-family:"Cascadia Code","Fira Code",monospace}
.diff-add{color:#4ade80}
.diff-del{color:#f87171}
.diff-hunk{color:#60a5fa}
.diff-meta{color:#64748b}
.diff-ctx{color:#94a3b8}
</style>
</head>
<body>
<div id="header">
  <h1>Pre-commit Review</h1>
  <span class="summary-pill">${totalFiles} file${totalFiles !== 1 ? "s" : ""}</span>
  <span class="summary-pill">${totalRecords} record${totalRecords !== 1 ? "s" : ""}</span>
  ${withWarnings > 0 ? `<span class="summary-pill warn">⚠ ${withWarnings} warning${withWarnings !== 1 ? "s" : ""}</span>` : ""}
</div>
<div id="content">
  <div class="base-row">Base: ${escHtml(base)}</div>
  ${filesHtml || '<p style="color:#64748b;padding:24px 0;text-align:center">No changed files.</p>'}
</div>
<script>
function toggleFile(idx) {
  const body = document.getElementById("body-" + idx);
  const chev = document.getElementById("chev-" + idx);
  const hidden = body.style.display === "none";
  body.style.display = hidden ? "" : "none";
  chev.classList.toggle("closed", !hidden);
}
// Auto-expand files with warnings
document.querySelectorAll(".file-section.has-warnings").forEach((el, i) => {
  const idx = el.id.replace("file-", "");
  document.getElementById("body-" + idx).style.display = "";
});
// Collapse files without warnings by default if > 5 files
if (${totalFiles} > 5) {
  document.querySelectorAll(".file-section:not(.has-warnings)").forEach(el => {
    const idx = el.id.replace("file-", "");
    const body = document.getElementById("body-" + idx);
    const chev = document.getElementById("chev-" + idx);
    if (body) { body.style.display = "none"; }
    if (chev) { chev.classList.add("closed"); }
  });
}
</script>
</body>
</html>`;
}
