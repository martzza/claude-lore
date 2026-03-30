import { createHash, randomUUID } from "crypto";
import { readdirSync, readFileSync, existsSync, statSync, realpathSync } from "fs";
import { join, basename, extname, relative } from "path";
import { sessionsDb } from "../sqlite/db.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface CursorRuleFile {
  path: string;
  relativePath: string;
  kind: "rule" | "persona" | "cursorrules";
  size: number;
}

export interface CursorRuleRecord {
  type: "decision" | "risk";
  content: string;
  rationale?: string;
  source: string;    // cursor:rules/<file>:<section>:<line>
  fingerprint: string;
  confidence: "inferred";
  exported_tier: "private";
  anchor_status: "healthy";
}

export interface CursorRulesImportOptions {
  repo: string;
  dryRun?: boolean;
  service?: string;
}

export interface CursorRulesImportResult {
  discovered: CursorRuleFile[];
  records: CursorRuleRecord[];
  written: number;
  skipped: number;
  dry_run: boolean;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const RULE_EXTENSIONS = new Set([".md", ".mdc", ".txt"]);
const MAX_FILE_SIZE = 200 * 1024; // 200 KB — rule files can be large

// Headings that contain non-negotiable constraints → risk records
const RISK_SECTION_RE =
  /never\s+do|must\s+not|non.?negotiable|critical|security|forbidden|prohibited|do\s+not|warning|danger|violation/i;

// Bullet/line starters that flag a risk regardless of section
const RISK_LINE_RE =
  /^[-*•]\s+(NEVER|MUST NOT|DO NOT|never |must not |do not |forbidden|prohibited|critical:|security:|warning:)/i;

// Bullet/line starters that flag a decision (architectural rule/constraint)
const DECISION_LINE_RE =
  /^[-*•\d.]\s+.{10,}/; // any substantive bullet

// Lines to skip — too short, separators, frontmatter markers, headings
const SKIP_LINE_RE = /^(---|===|#|\s*$)/;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function sha256(source: string, content: string): string {
  return createHash("sha256").update(source + content).digest("hex").slice(0, 16);
}

/** Strip YAML frontmatter block (--- ... ---) from the top of a file. */
function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  return content.slice(end + 4).trimStart();
}

/** Detect the current section heading from a markdown line. */
function extractHeading(line: string): string | null {
  const m = /^#{1,4}\s+(.+)/.exec(line);
  return m ? m[1]!.trim() : null;
}

/** Clean a bullet point: strip leading -, *, •, digit+dot, bold markers. */
function cleanBullet(line: string): string {
  return line
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1") // remove bold markers
    .trim();
}

/** Infer if a bullet should be a risk based on its content. */
function isRiskContent(text: string): boolean {
  return /\b(MUST NOT|NEVER|DO NOT|never |must not |forbidden|prohibited|critical|security breach|attack|vulnerability|exploit|plain.?text|no.?auth|bypass|skip.*verify|unsafe)/i.test(text);
}

// ─── File discovery ─────────────────────────────────────────────────────────────

function isWithinRepo(repo: string, filePath: string): boolean {
  try {
    const real = realpathSync(filePath);
    const repoReal = realpathSync(repo);
    return real.startsWith(repoReal + "/") || real === repoReal;
  } catch {
    return false; // if realpathSync fails (e.g. broken symlink), exclude
  }
}

function discoverRuleFiles(repo: string): CursorRuleFile[] {
  const files: CursorRuleFile[] = [];

  // .cursor/rules/*.{md,mdc,txt}
  const rulesDir = join(repo, ".cursor", "rules");
  if (existsSync(rulesDir)) {
    let entries: string[] = [];
    try { entries = readdirSync(rulesDir); } catch {}
    for (const entry of entries) {
      if (!RULE_EXTENSIONS.has(extname(entry))) continue;
      const full = join(rulesDir, entry);
      if (!isWithinRepo(repo, full)) continue; // guard against symlinks escaping repo
      let size = 0;
      try { size = statSync(full).size; } catch { continue; }
      if (size > MAX_FILE_SIZE) continue;
      files.push({
        path: full,
        relativePath: relative(repo, full),
        kind: "rule",
        size,
      });
    }
  }

  // .cursor/personas/*.{md,mdc,txt}
  const personasDir = join(repo, ".cursor", "personas");
  if (existsSync(personasDir)) {
    let entries: string[] = [];
    try { entries = readdirSync(personasDir); } catch {}
    for (const entry of entries) {
      if (!RULE_EXTENSIONS.has(extname(entry))) continue;
      const full = join(personasDir, entry);
      if (!isWithinRepo(repo, full)) continue; // guard against symlinks escaping repo
      let size = 0;
      try { size = statSync(full).size; } catch { continue; }
      if (size > MAX_FILE_SIZE) continue;
      files.push({
        path: full,
        relativePath: relative(repo, full),
        kind: "persona",
        size,
      });
    }
  }

  // .cursorrules (flat rules file at repo root)
  const cursorrulesPath = join(repo, ".cursorrules");
  if (existsSync(cursorrulesPath)) {
    let size = 0;
    try { size = statSync(cursorrulesPath).size; } catch {}
    if (size <= MAX_FILE_SIZE) {
      files.push({
        path: cursorrulesPath,
        relativePath: ".cursorrules",
        kind: "cursorrules",
        size,
      });
    }
  }

  return files;
}

// ─── Extraction ────────────────────────────────────────────────────────────────

function extractFromRuleFile(
  content: string,
  relPath: string,
): CursorRuleRecord[] {
  const body = stripFrontmatter(content);
  const lines = body.split("\n");
  const records: CursorRuleRecord[] = [];

  let currentSection = "general";
  let sectionIsRisk = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Track section headings
    const heading = extractHeading(line);
    if (heading) {
      currentSection = heading;
      sectionIsRisk = RISK_SECTION_RE.test(heading);
      continue;
    }

    // Skip separators, blank lines, frontmatter markers
    if (SKIP_LINE_RE.test(line)) continue;

    // Only extract bullet points and numbered items (the actual rules)
    if (!DECISION_LINE_RE.test(line)) continue;

    const cleaned = cleanBullet(line);
    if (cleaned.length < 10) continue; // too short to be meaningful

    // Determine type
    const isRisk = sectionIsRisk || isRiskContent(cleaned) || RISK_LINE_RE.test(line);
    const type: "decision" | "risk" = isRisk ? "risk" : "decision";

    // source: cursor:{kind}/<filename>:<section>
    const fileBase = basename(relPath);
    const source = `cursor:${relPath}:${currentSection}`;
    const fingerprint = sha256(source, cleaned);

    records.push({
      type,
      content: cleaned.slice(0, 500),
      rationale: currentSection !== "general" ? `From section: ${currentSection}` : undefined,
      source,
      fingerprint,
      confidence: "inferred",
      exported_tier: "private",
      anchor_status: "healthy",
    });

    void fileBase; // used only for source label above
  }

  return records;
}

// ─── Dedup ────────────────────────────────────────────────────────────────────

function dedup(records: CursorRuleRecord[]): CursorRuleRecord[] {
  const seen = new Set<string>();
  return records.filter((r) => {
    if (seen.has(r.fingerprint)) return false;
    seen.add(r.fingerprint);
    return true;
  });
}

// ─── DB write ─────────────────────────────────────────────────────────────────

async function fingerprintExists(fingerprint: string, repo: string, table: string): Promise<boolean> {
  const res = await sessionsDb.execute({
    sql: `SELECT id FROM ${table} WHERE fingerprint = ? AND repo = ? LIMIT 1`,
    args: [fingerprint, repo],
  });
  return res.rows.length > 0;
}

async function writeRecord(
  record: CursorRuleRecord,
  repo: string,
  service?: string,
): Promise<boolean> {
  const id = randomUUID();
  const now = Date.now();
  const svc = service ?? null;

  if (record.type === "decision") {
    if (await fingerprintExists(record.fingerprint, repo, "decisions")) return false;
    await sessionsDb.execute({
      sql: `INSERT INTO decisions
              (id, repo, session_id, symbol, content, rationale, confidence,
               exported_tier, anchor_status, source, fingerprint, created_at, service)
            VALUES (?, ?, NULL, NULL, ?, ?, 'inferred', 'private', 'healthy', ?, ?, ?, ?)`,
      args: [id, repo, record.content, record.rationale ?? null, record.source, record.fingerprint, now, svc],
    });
  } else {
    if (await fingerprintExists(record.fingerprint, repo, "risks")) return false;
    await sessionsDb.execute({
      sql: `INSERT INTO risks
              (id, repo, session_id, symbol, content, confidence,
               exported_tier, anchor_status, source, fingerprint, created_at, service)
            VALUES (?, ?, NULL, NULL, ?, 'inferred', 'private', 'healthy', ?, ?, ?, ?)`,
      args: [id, repo, record.content, record.source, record.fingerprint, now, svc],
    });
  }

  return true;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runCursorRulesImport(
  opts: CursorRulesImportOptions,
): Promise<CursorRulesImportResult> {
  const { repo, dryRun = false, service } = opts;

  const discovered = discoverRuleFiles(repo);
  const allRecords: CursorRuleRecord[] = [];

  for (const file of discovered) {
    let content: string;
    try {
      content = readFileSync(file.path, "utf8");
    } catch {
      continue;
    }
    allRecords.push(...extractFromRuleFile(content, file.relativePath));
  }

  const deduped = dedup(allRecords);

  let written = 0;
  let skipped = 0;

  if (!dryRun) {
    for (const record of deduped) {
      const ok = await writeRecord(record, repo, service);
      if (ok) written++;
      else skipped++;
    }
  }

  return {
    discovered,
    records: deduped,
    written,
    skipped,
    dry_run: dryRun,
  };
}
