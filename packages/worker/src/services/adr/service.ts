import { execSync, execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { sessionsDb } from "../sqlite/db.js";

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
): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await sessionsDb.execute({
    sql: `INSERT OR IGNORE INTO decisions
            (id, repo, session_id, content, rationale, confidence, exported_tier,
             anchor_status, adr_status, adr_title, adr_context, adr_alternatives, created_at)
          VALUES (?, ?, ?, ?, ?, 'extracted', 'private', 'healthy', 'draft', ?, ?, ?, ?)`,
    args: [
      id, repo, sessionId ?? null, content,
      rationale ?? null, title, context ?? null, alternatives ?? null, now,
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
