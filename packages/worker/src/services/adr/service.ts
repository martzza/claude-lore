import { execSync, execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { sessionsDb } from "../sqlite/db.js";

// ---------------------------------------------------------------------------
// ADR frontmatter parsing
// ---------------------------------------------------------------------------

export interface AdrFrontmatter {
  status?: string;        // accepted | superseded | deprecated | rejected | proposed | draft
  supersededBy?: string;  // referenced ADR number / filename from "Superseded-by:" field
  supersedes?: string;    // referenced ADR from "Supersedes:" field
  date?: string;
}

/** Parse lifecycle-relevant frontmatter from an ADR markdown file. */
export function parseAdrFrontmatter(content: string): AdrFrontmatter {
  const fm: AdrFrontmatter = {};

  const statusMatch = /^status:\s*(.+)$/im.exec(content);
  if (statusMatch) fm.status = statusMatch[1]!.trim().toLowerCase();

  // "Superseded-by: ADR-003" or "Superseded by: ADR-003"
  const supersededByMatch = /^superseded[- ]by:\s*(.+)$/im.exec(content);
  if (supersededByMatch) fm.supersededBy = supersededByMatch[1]!.trim();

  // "Supersedes: ADR-001"
  const supersedes = /^supersedes:\s*(.+)$/im.exec(content);
  if (supersedes) fm.supersedes = supersedes[1]!.trim();

  const dateMatch = /^date:\s*(.+)$/im.exec(content);
  if (dateMatch) fm.date = dateMatch[1]!.trim();

  return fm;
}

/** Map ADR frontmatter status to lifecycle_status value. */
export function adrStatusToLifecycle(status: string | undefined): string {
  if (!status) return "active";
  if (status.includes("superseded")) return "superseded";
  if (status.includes("deprecated") || status.includes("rejected")) return "archived";
  return "active";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdrRecord {
  id: string;
  repo: string;
  adr_title: string;
  adr_status: string;          // draft | accepted | superseded
  adr_context: string | null;
  adr_alternatives: string | null;
  content: string;             // the decision
  rationale: string | null;
  confidence: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getAdrCandidates(repo: string): Promise<AdrRecord[]> {
  const res = await sessionsDb.execute({
    sql: `SELECT id, repo, adr_title, adr_status, adr_context, adr_alternatives,
                 content, rationale, confidence, created_at
          FROM decisions
          WHERE repo = ? AND adr_status = 'draft' AND confidence = 'extracted'
          ORDER BY created_at DESC`,
    args: [repo],
  });
  return res.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: String(row["id"]),
      repo: String(row["repo"]),
      adr_title: String(row["adr_title"] ?? row["content"]).slice(0, 80),
      adr_status: String(row["adr_status"] ?? "draft"),
      adr_context: row["adr_context"] != null ? String(row["adr_context"]) : null,
      adr_alternatives: row["adr_alternatives"] != null ? String(row["adr_alternatives"]) : null,
      content: String(row["content"]),
      rationale: row["rationale"] != null ? String(row["rationale"]) : null,
      confidence: String(row["confidence"]),
      created_at: Number(row["created_at"]),
    };
  });
}

export async function createDraftAdr(
  repo: string,
  title: string,
  content: string,
  rationale?: string,
  context?: string,
  alternatives?: string,
  sessionId?: string,
  lifecycleStatus?: string,
  supersededBy?: string,
): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  const ls = lifecycleStatus ?? "active";
  // ADR status: map lifecycle to adr_status (superseded/archived → superseded; else draft)
  const adrStatus = ls === "active" ? "draft" : "superseded";

  await sessionsDb.execute({
    sql: `INSERT OR IGNORE INTO decisions
            (id, repo, session_id, content, rationale, confidence, exported_tier,
             anchor_status, adr_status, adr_title, adr_context, adr_alternatives,
             lifecycle_status, superseded_by, created_at)
          VALUES (?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, repo, sessionId ?? null, content,
      rationale ?? null, adrStatus, title, context ?? null, alternatives ?? null,
      ls, supersededBy ?? null, now,
    ],
  });
  return id;
}

export async function confirmAdr(id: string, confirmedBy: string): Promise<void> {
  await sessionsDb.execute({
    sql: `UPDATE decisions
          SET adr_status = 'accepted', confidence = 'confirmed', confirmed_by = ?
          WHERE id = ? AND adr_status = 'draft'`,
    args: [confirmedBy, id],
  });
}

export async function discardAdr(id: string): Promise<void> {
  await sessionsDb.execute({
    sql: `UPDATE decisions SET adr_status = 'superseded' WHERE id = ?`,
    args: [id],
  });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatAdrComment(adr: AdrRecord): string {
  const lines: string[] = [
    `## ADR Candidate: ${adr.adr_title}`,
    ``,
    `**Context:** ${adr.adr_context ?? "_Not yet documented_"}`,
    ``,
    `**Decision:** ${adr.content}`,
    ``,
    `**Rationale:** ${adr.rationale ?? "_Not yet documented_"}`,
    ``,
    `**Alternatives considered:** ${adr.adr_alternatives ?? "_Not yet documented_"}`,
    ``,
    `---`,
    `To promote: \`claude-lore adr confirm ${adr.id}\``,
    `To archive: \`claude-lore adr discard ${adr.id}\``,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// PR posting
// ---------------------------------------------------------------------------

export function postAdrComment(body: string): { posted: boolean; method: string } {
  try {
    execSync("gh --version", { stdio: "ignore" });
    execFileSync("gh", ["pr", "comment", "--body", body], { stdio: "inherit" });
    return { posted: true, method: "gh" };
  } catch {
    return { posted: false, method: "stdout" };
  }
}
