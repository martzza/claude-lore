import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, extname, relative, basename } from "path";
import type { LoreTemplate, GeneratedRecord, TemplateContext } from "../../types.js";

// ─── Constants (mirrors cursor-rules-importer.ts) ─────────────────────────────

const RULE_EXTENSIONS = new Set([".md", ".mdc", ".txt"]);
const MAX_FILE_SIZE = 200 * 1024;

const RISK_SECTION_RE =
  /never\s+do|must\s+not|non.?negotiable|critical|security|forbidden|prohibited|do\s+not|warning|danger|violation/i;

const RISK_LINE_RE =
  /^[-*•]\s+(NEVER|MUST NOT|DO NOT|never |must not |do not |forbidden|prohibited|critical:|security:|warning:)/i;

const DECISION_LINE_RE = /^[-*•\d.]\s+.{10,}/;

const SKIP_LINE_RE = /^(---|===|#|\s*$)/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  return content.slice(end + 4).trimStart();
}

function extractHeading(line: string): string | null {
  const m = /^#{1,4}\s+(.+)/.exec(line);
  return m ? m[1]!.trim() : null;
}

function cleanBullet(line: string): string {
  return line
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .trim();
}

function isRiskContent(text: string): boolean {
  return /\b(MUST NOT|NEVER|DO NOT|never |must not |forbidden|prohibited|critical|security breach|attack|vulnerability|exploit|plain.?text|no.?auth|bypass|skip.*verify|unsafe)/i.test(text);
}

// ─── Extraction ───────────────────────────────────────────────────────────────

function extractFromFile(content: string, _relPath: string): Array<{ type: "decision" | "risk"; content: string; rationale?: string }> {
  const body = stripFrontmatter(content);
  const lines = body.split("\n");
  const records: Array<{ type: "decision" | "risk"; content: string; rationale?: string }> = [];

  let currentSection = "general";
  let sectionIsRisk = false;
  const seen = new Set<string>();

  for (const line of lines) {
    const heading = extractHeading(line);
    if (heading) {
      currentSection = heading;
      sectionIsRisk = RISK_SECTION_RE.test(heading);
      continue;
    }

    if (SKIP_LINE_RE.test(line)) continue;
    if (!DECISION_LINE_RE.test(line)) continue;

    const cleaned = cleanBullet(line);
    if (cleaned.length < 10) continue;

    // Dedup within this file
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);

    const isRisk = sectionIsRisk || isRiskContent(cleaned) || RISK_LINE_RE.test(line);
    records.push({
      type: isRisk ? "risk" : "decision",
      content: cleaned.slice(0, 500),
      rationale: currentSection !== "general" ? `From cursor rules section: ${currentSection}` : undefined,
    });
  }

  return records;
}

function discoverRuleFiles(repo: string): Array<{ path: string; rel: string }> {
  const files: Array<{ path: string; rel: string }> = [];

  const tryDir = (dir: string) => {
    if (!existsSync(dir)) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (!RULE_EXTENSIONS.has(extname(entry))) continue;
      const full = join(dir, entry);
      try {
        if (statSync(full).size > MAX_FILE_SIZE) continue;
      } catch { continue; }
      files.push({ path: full, rel: relative(repo, full) });
      void basename; // suppress lint
    }
  };

  tryDir(join(repo, ".cursor", "rules"));
  tryDir(join(repo, ".cursor", "personas"));

  const flat = join(repo, ".cursorrules");
  if (existsSync(flat)) {
    try {
      if (statSync(flat).size <= MAX_FILE_SIZE) files.push({ path: flat, rel: ".cursorrules" });
    } catch {}
  }

  return files;
}

// ─── Template ─────────────────────────────────────────────────────────────────

const template: LoreTemplate = {
  id: "cursor-rules",
  name: "Cursor Rules Import",
  description:
    "Discovers .cursor/rules/, .cursor/personas/, and .cursorrules files and imports their " +
    "rules and constraints into the knowledge graph. Use this to sync Cursor team rules into " +
    "claude-lore so Claude Code sessions also benefit from them.",
  version: "1.0.0",
  questions: [
    {
      id: "confirm",
      type: "confirm",
      prompt:
        "Import all rules from .cursor/rules/, .cursor/personas/, and .cursorrules into the knowledge graph?",
      default: true,
    },
  ],
  generate(answers: Record<string, unknown>, context: TemplateContext): GeneratedRecord[] {
    if (answers["confirm"] === false) return [];

    const repo = context.repo;
    const ruleFiles = discoverRuleFiles(repo);

    if (ruleFiles.length === 0) {
      return [
        {
          type: "deferred",
          content:
            "No cursor rules files found (.cursor/rules/, .cursor/personas/, .cursorrules). " +
            "Add team rules to .cursor/rules/ and re-run `claude-lore bootstrap --framework cursor-rules` to import them.",
          confidence: "inferred",
          exported_tier: "private",
          anchor_status: "healthy",
        },
      ];
    }

    const records: GeneratedRecord[] = [];
    const contentSeen = new Set<string>();

    for (const file of ruleFiles) {
      let raw: string;
      try {
        raw = readFileSync(file.path, "utf8");
      } catch {
        continue;
      }

      const extracted = extractFromFile(raw, file.rel);
      for (const r of extracted) {
        if (contentSeen.has(r.content)) continue;
        contentSeen.add(r.content);

        records.push({
          type: r.type,
          content: r.content,
          rationale: r.rationale ?? `Imported from ${file.rel}`,
          confidence: "inferred",
          exported_tier: "private",
          anchor_status: "healthy",
        });
      }
    }

    if (records.length === 0) {
      return [
        {
          type: "deferred",
          content:
            `Cursor rules files found (${ruleFiles.map((f) => f.rel).join(", ")}) but no extractable rules. ` +
            "Ensure files contain bullet-point rules or numbered lists.",
          confidence: "inferred",
          exported_tier: "private",
          anchor_status: "healthy",
        },
      ];
    }

    return records;
  },
};

export default template;
