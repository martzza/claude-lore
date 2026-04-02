import { createHash, randomUUID } from "crypto";
import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, relative, basename } from "path";
import { sessionsDb } from "../sqlite/db.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type FileClass =
  | "adr"
  | "architecture"
  | "runbook"
  | "security"
  | "changelog"
  | "claude"
  | "readme"
  | "generic";

export interface DiscoveredFile {
  path: string;
  relativePath: string;
  classes: FileClass[];
  size: number;
}

export interface ImportedRecord {
  type: "decision" | "deferred" | "risk";
  content: string;
  rationale?: string;
  source: string; // md:{relative-path}:{section-heading|line-number|ADR}
  fingerprint: string;
  confidence: "inferred";
  exported_tier: "private";
  anchor_status: "healthy";
}

export interface ImportRunOptions {
  repo: string;
  path?: string; // scan a specific subdirectory
  file?: string; // import a single file
  dryRun?: boolean;
}

export interface ImportRunResult {
  discovered: DiscoveredFile[];
  records: ImportedRecord[];
  written: number;
  skipped: number; // duplicate fingerprints already in DB
  dry_run: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".codegraph",
]);

const MAX_FILE_SIZE = 100 * 1024; // 100 KB
const MAX_FILES = 200;

// Lower score = higher priority when capping at MAX_FILES
const FILE_SCORE: Record<string, number> = {
  adr: 0,
  security: 1,
  architecture: 2,
  claude: 3,
  runbook: 4,
  changelog: 5,
  readme: 6,
  generic: 7,
};

// ─── Classification ───────────────────────────────────────────────────────────

const FILENAME_SIGNALS: Array<[FileClass, RegExp]> = [
  ["adr", /adr|decision|architecture-decision|rfc/i],
  ["architecture", /architecture|arch|design|system|overview|structure/i],
  ["runbook", /runbook|ops|deploy|deployment|operations|incident/i],
  ["security", /security|threat|vulnerability|pentest|audit/i],
  ["changelog", /changelog|history|releases|versions/i],
  ["claude", /claude|agent|ai|llm|copilot|cursor/i],
  ["readme", /^readme$/i],
];

function classifyFile(filePath: string, content: string): FileClass[] {
  const base = basename(filePath, ".md");
  const classes = new Set<FileClass>();

  // Filename signals
  for (const [cls, re] of FILENAME_SIGNALS) {
    if (re.test(base)) classes.add(cls);
  }

  // Directory signals for ADR
  if (/\/(decisions|adrs?|rfcs?)\//i.test(filePath)) classes.add("adr");
  if (/\/security\//i.test(filePath)) classes.add("security");

  // Content signals (first 500 chars)
  const head = content.slice(0, 500);

  if (/## Status|## Context|## Decision|## Rationale|Accepted|Proposed|Superseded/i.test(head)) {
    classes.add("adr");
  }

  const h2Count = (content.match(/^## /gm) ?? []).length;
  if (
    h2Count >= 3 &&
    /service|component|layer|module|pattern|system|architecture/i.test(content)
  ) {
    classes.add("architecture");
  }

  if (/step[- ]by[- ]step|prerequisites?|warning:|caution:/i.test(head)) {
    classes.add("runbook");
  }

  if (/cve-\d|owasp|vulnerabilit|attack surface|pentest/i.test(head)) {
    classes.add("security");
  }

  if (/breaking change|deprecated|version \d+\.\d+/i.test(head)) {
    classes.add("changelog");
  }

  if (/you are|your job|conventions|never do|always do/i.test(head)) {
    classes.add("claude");
  }

  if (classes.size === 0) classes.add("generic");

  return Array.from(classes);
}

// ─── .gitignore parsing ───────────────────────────────────────────────────────

function parseGitignore(repoRoot: string): RegExp[] {
  const path = join(repoRoot, ".gitignore");
  if (!existsSync(path)) return [];

  const patterns: RegExp[] = [];
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    return [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;

    let pattern = line
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "\x00") // placeholder
      .replace(/\*/g, "[^/]*")
      .replace(/\x00/g, ".*");

    pattern = line.startsWith("/")
      ? "^" + pattern.slice(1)
      : "(^|/)" + pattern;

    // Directory patterns: match the dir prefix
    if (!pattern.endsWith("$")) pattern += "(/|$)";

    try {
      patterns.push(new RegExp(pattern));
    } catch {
      // malformed — skip
    }
  }

  return patterns;
}

function isIgnored(relPath: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(relPath));
}

// ─── File discovery ───────────────────────────────────────────────────────────

interface ScoredFile {
  path: string;
  relativePath: string;
  size: number;
  score: number;
}

function scoreFilename(base: string, relPath: string): number {
  const b = base.toLowerCase();
  const r = relPath.toLowerCase();
  if (/adr|decision|rfc/.test(b) || /\/(decisions|adrs?|rfcs?)\//i.test(r)) return FILE_SCORE["adr"]!;
  if (/security|threat/.test(b) || /\/security\//.test(r)) return FILE_SCORE["security"]!;
  if (/architecture|arch|design/.test(b)) return FILE_SCORE["architecture"]!;
  if (/claude|agent|llm/.test(b)) return FILE_SCORE["claude"]!;
  if (/runbook|deploy|ops/.test(b)) return FILE_SCORE["runbook"]!;
  if (/changelog|history/.test(b)) return FILE_SCORE["changelog"]!;
  if (/readme/.test(b)) return FILE_SCORE["readme"]!;
  return FILE_SCORE["generic"]!;
}

function walkDir(
  dir: string,
  repoRoot: string,
  gitignorePatterns: RegExp[],
  out: ScoredFile[],
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (out.length >= MAX_FILES * 3) break; // over-collect, trim after sort

    // Skip known noise dirs
    if (SKIP_DIRS.has(entry)) continue;
    // Skip hidden dirs except .github
    if (entry.startsWith(".") && entry !== ".github") continue;

    const full = join(dir, entry);
    const rel = relative(repoRoot, full);

    if (isIgnored(rel, gitignorePatterns)) continue;

    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      walkDir(full, repoRoot, gitignorePatterns, out);
    } else if (/\.md$/i.test(entry)) {
      if (st.size > MAX_FILE_SIZE) continue;
      const base = basename(entry, ".md");
      out.push({
        path: full,
        relativePath: rel,
        size: st.size,
        score: scoreFilename(base, rel),
      });
    }
  }
}

async function discoverFiles(root: string, gitignorePatterns: RegExp[]): Promise<ScoredFile[]> {
  const found: ScoredFile[] = [];
  walkDir(root, root, gitignorePatterns, found);
  found.sort((a, b) => a.score - b.score || a.relativePath.localeCompare(b.relativePath));
  return found.slice(0, MAX_FILES);
}

// ─── Section splitting ────────────────────────────────────────────────────────

interface Section {
  heading: string;
  level: 2 | 3;
  body: string;
}

function splitSections(content: string): Section[] {
  const lines = content.split("\n");
  const sections: Section[] = [];
  let current: { heading: string; level: 2 | 3 } | null = null;
  let bodyLines: string[] = [];

  const flush = () => {
    if (current) {
      sections.push({ ...current, body: bodyLines.join("\n").trim() });
    }
  };

  for (const line of lines) {
    const h2 = /^## (.+)/.exec(line);
    const h3 = /^### (.+)/.exec(line);
    const match = h2 ?? h3;

    if (match) {
      flush();
      current = { heading: match[1]!.trim(), level: h2 ? 2 : 3 };
      bodyLines = [];
    } else if (current) {
      bodyLines.push(line);
    }
  }
  flush();

  return sections;
}

// ─── Fingerprint ──────────────────────────────────────────────────────────────

function makeFingerprint(source: string, content: string): string {
  return createHash("sha256").update(source + content).digest("hex").slice(0, 16);
}

// ─── Decision extraction ──────────────────────────────────────────────────────

const DECISION_HEADING_RE =
  /\b(why|chose|rationale|approach|strategy|trade-?off|design choice|we use|we chose|we picked)\b/i;

// Generic meta-headings that match DECISION_HEADING_RE but contain no real decision
const DECISION_HEADING_NOISE =
  /^(key (architectural )?decisions?|related decisions?|decision log|rationale|architecture|design|approach|strategy)$/i;

const DECISION_BODY_SIGNALS = [
  /\bbecause\b/i,
  /\btherefore\b/i,
  /\bchosen\b/i,
  /\bselected\b/i,
  /\binstead of\b/i,
  /\brather than\b/i,
  /\btrade-?off\b/i,
  /\bvs\.?\b/i,
  /\bwe decided\b/i,
  /\bwe chose\b/i,
  /\bover\b.*\bfor\b/i,
];

const MIN_BODY_LEN = 80; // anything shorter is a heading-only stub, not a real decision

function extractDecisions(sections: Section[], relPath: string): ImportedRecord[] {
  const records: ImportedRecord[] = [];

  for (const sec of sections) {
    // Skip generic meta-headings that match the regex but carry no decision content
    if (DECISION_HEADING_NOISE.test(sec.heading.trim())) continue;

    const bodySignals = DECISION_BODY_SIGNALS.filter((re) => re.test(sec.body)).length;
    const headingMatch = DECISION_HEADING_RE.test(sec.heading);

    // Need either: heading match + body signal, OR ≥2 body signals
    if (headingMatch && bodySignals < 1) continue;
    if (!headingMatch && bodySignals < 2) continue;

    // Require substantive body — stub sections with no real content add noise
    if (sec.body.trim().length < MIN_BODY_LEN) continue;

    const source = `md:${relPath}:${sec.heading}`;
    // Store the body as the decision content (the actual reasoning), heading as context prefix
    const body = sec.body.trim().slice(0, 400);
    const content = `${sec.heading}: ${body}`;
    const fingerprint = makeFingerprint(source, content);

    records.push({
      type: "decision",
      content,
      source,
      fingerprint,
      confidence: "inferred",
      exported_tier: "private",
      anchor_status: "healthy",
    });
  }

  return records;
}

// ─── Risk extraction ──────────────────────────────────────────────────────────

const RISK_HEADING_RE =
  /risk|warning|caution|danger|issue|problem|limitation|caveat|security|known issue/i;

const RISK_BODY_RE =
  /must not|never|do not|avoid|careful|breaking|deprecated|critical|important/i;

const SEVERITY_RULES: Array<[RegExp, string]> = [
  [/critical|must not|never|breaking/i, "critical"],
  [/important|security|do not|required/i, "high"],
  [/warning|caution|avoid|careful/i, "medium"],
  [/note|consider|may|might/i, "low"],
];

function inferSeverity(heading: string, body: string): string {
  const text = `${heading} ${body}`;
  for (const [re, sev] of SEVERITY_RULES) {
    if (re.test(text)) return sev;
  }
  return "medium";
}

function extractRisks(
  sections: Section[],
  relPath: string,
  elevate = false,
): ImportedRecord[] {
  const records: ImportedRecord[] = [];

  for (const sec of sections) {
    if (!RISK_HEADING_RE.test(sec.heading) && !RISK_BODY_RE.test(sec.body)) continue;

    let severity = inferSeverity(sec.heading, sec.body);
    if (elevate && (severity === "medium" || severity === "low")) severity = "high";

    const source = `md:${relPath}:${sec.heading}`;
    const content = `[${severity}] ${sec.heading}: ${sec.body.slice(0, 200)}`;
    const fingerprint = makeFingerprint(source, content);

    records.push({
      type: "risk",
      content,
      source,
      fingerprint,
      confidence: "inferred",
      exported_tier: "private",
      anchor_status: "healthy",
    });
  }

  return records;
}

// ─── Deferred extraction ──────────────────────────────────────────────────────

const DEFERRED_RE =
  /TODO|FIXME|HACK|WIP|not yet implemented|planned|future work|coming soon|phase \d+|will be added|to be done/i;

function extractDeferred(content: string, relPath: string): ImportedRecord[] {
  const records: ImportedRecord[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!DEFERRED_RE.test(line)) continue;

    const desc = line.trim().slice(0, 200);
    if (!desc) continue;

    const source = `md:${relPath}:${i + 1}`;
    const fingerprint = makeFingerprint(source, desc);

    records.push({
      type: "deferred",
      content: desc,
      source,
      fingerprint,
      confidence: "inferred",
      exported_tier: "private",
      anchor_status: "healthy",
    });
  }

  return records;
}

// ─── ADR structured parse ─────────────────────────────────────────────────────

function parseAdr(content: string, relPath: string): ImportedRecord[] {
  const sections = splitSections(content);

  // Build a lowercase heading map
  const byHeading = new Map<string, string>();
  for (const sec of sections) {
    byHeading.set(sec.heading.toLowerCase(), sec.body);
  }

  const contextRaw = byHeading.get("context") ?? "";
  const decisionRaw = byHeading.get("decision") ?? "";
  const rationaleRaw =
    byHeading.get("rationale") ?? byHeading.get("consequences") ?? "";
  const alternativesRaw = byHeading.get("alternatives") ?? "";

  if (!contextRaw && !decisionRaw && !rationaleRaw) {
    // Fall back to generic extraction
    return extractDecisions(sections, relPath);
  }

  const titleMatch = /^# (.+)/m.exec(content);
  const title = titleMatch?.[1]?.trim() ?? basename(relPath, ".md");

  const rationale = [
    contextRaw && `Context: ${contextRaw.slice(0, 200)}`,
    decisionRaw && `Decision: ${decisionRaw.slice(0, 200)}`,
    rationaleRaw && `Rationale: ${rationaleRaw.slice(0, 200)}`,
    alternativesRaw && `Alternatives: ${alternativesRaw.slice(0, 200)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const source = `md:${relPath}:ADR`;
  const fingerprint = makeFingerprint(source, title);

  return [
    {
      type: "decision",
      content: title,
      rationale: rationale || undefined,
      source,
      fingerprint,
      confidence: "inferred",
      exported_tier: "private",
      anchor_status: "healthy",
    },
  ];
}

// ─── Per-file extraction dispatcher ──────────────────────────────────────────

function dedup(records: ImportedRecord[]): ImportedRecord[] {
  const seen = new Set<string>();
  return records.filter((r) => {
    if (seen.has(r.fingerprint)) return false;
    seen.add(r.fingerprint);
    return true;
  });
}

function extractFromFile(
  content: string,
  relPath: string,
  classes: FileClass[],
): ImportedRecord[] {
  const classSet = new Set(classes);
  const records: ImportedRecord[] = [];

  // ADR: structured parse + deferred scan
  if (classSet.has("adr")) {
    records.push(...parseAdr(content, relPath));
    records.push(...extractDeferred(content, relPath));
    return dedup(records);
  }

  // README: light scan — decisions only, no risks or deferred
  if (classSet.has("readme") && classSet.size === 1) {
    records.push(...extractDecisions(splitSections(content), relPath));
    return dedup(records);
  }

  // All other classes: full extraction
  const sections = splitSections(content);

  records.push(...extractDecisions(sections, relPath));
  records.push(...extractRisks(sections, relPath, classSet.has("security")));
  records.push(...extractDeferred(content, relPath));

  return dedup(records);
}

// ─── Database write ───────────────────────────────────────────────────────────

async function fingerprintExists(
  fingerprint: string,
  repo: string,
  table: string,
): Promise<boolean> {
  const result = await sessionsDb.execute({
    sql: `SELECT id FROM ${table} WHERE fingerprint = ? AND repo = ? LIMIT 1`,
    args: [fingerprint, repo],
  });
  return result.rows.length > 0;
}

async function writeImportedRecord(record: ImportedRecord, repo: string): Promise<boolean> {
  const id = randomUUID();
  const now = Date.now();

  if (record.type === "decision") {
    if (await fingerprintExists(record.fingerprint, repo, "decisions")) return false;
    await sessionsDb.execute({
      sql: `INSERT INTO decisions
              (id, repo, session_id, symbol, content, rationale, confidence,
               exported_tier, anchor_status, source, fingerprint, created_at)
            VALUES (?, ?, NULL, NULL, ?, ?, 'inferred', 'private', 'healthy', ?, ?, ?)`,
      args: [
        id,
        repo,
        record.content,
        record.rationale ?? null,
        record.source,
        record.fingerprint,
        now,
      ],
    });
  } else if (record.type === "deferred") {
    if (await fingerprintExists(record.fingerprint, repo, "deferred_work")) return false;
    await sessionsDb.execute({
      sql: `INSERT INTO deferred_work
              (id, repo, session_id, symbol, content, confidence,
               exported_tier, anchor_status, status, source, fingerprint, created_at)
            VALUES (?, ?, NULL, NULL, ?, 'inferred', 'private', 'healthy', 'open', ?, ?, ?)`,
      args: [id, repo, record.content, record.source, record.fingerprint, now],
    });
  } else {
    if (await fingerprintExists(record.fingerprint, repo, "risks")) return false;
    await sessionsDb.execute({
      sql: `INSERT INTO risks
              (id, repo, session_id, symbol, content, confidence,
               exported_tier, anchor_status, source, fingerprint, created_at)
            VALUES (?, ?, NULL, NULL, ?, 'inferred', 'private', 'healthy', ?, ?, ?)`,
      args: [id, repo, record.content, record.source, record.fingerprint, now],
    });
  }

  return true;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runImport(opts: ImportRunOptions): Promise<ImportRunResult> {
  const { repo, dryRun = false } = opts;

  const root = opts.path ? join(repo, opts.path) : repo;
  const gitignorePatterns = parseGitignore(repo);

  let scoredFiles: Array<{ path: string; relativePath: string; size: number }>;

  if (opts.file) {
    const full = join(repo, opts.file);
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {}
    scoredFiles = [{ path: full, relativePath: opts.file, size }];
  } else {
    scoredFiles = await discoverFiles(root, gitignorePatterns);
  }

  const discovered: DiscoveredFile[] = [];
  const allRecords: ImportedRecord[] = [];

  for (const sf of scoredFiles) {
    let content: string;
    try {
      content = readFileSync(sf.path, "utf8");
    } catch {
      continue;
    }

    const classes = classifyFile(sf.path, content);
    discovered.push({
      path: sf.path,
      relativePath: sf.relativePath,
      classes,
      size: sf.size,
    });

    allRecords.push(...extractFromFile(content, sf.relativePath, classes));
  }

  // Global dedup across all files
  const seen = new Set<string>();
  const deduped = allRecords.filter((r) => {
    if (seen.has(r.fingerprint)) return false;
    seen.add(r.fingerprint);
    return true;
  });

  let written = 0;
  let skipped = 0;

  if (!dryRun) {
    for (const record of deduped) {
      const ok = await writeImportedRecord(record, repo);
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
