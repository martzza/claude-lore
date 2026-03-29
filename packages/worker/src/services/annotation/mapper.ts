import { readFileSync } from "fs";
import { extname } from "path";
import { getReasoningData } from "../reasoning/service.js";
import { sessionsDb } from "../sqlite/db.js";

export interface SymbolLocation {
  symbol: string;
  file: string;
  start_line: number;
  end_line: number;
}

export interface AnnotationRecord {
  id: string;
  type: "decision" | "risk" | "deferred" | "session";
  title: string;
  summary: string;   // short version for inline display
  full: string;      // full content for expand-on-click
  confidence: string;
  severity?: string; // for risks
  session_id?: string;
  chain: string[];   // record IDs in provenance chain, oldest first
}

export interface Annotation {
  line: number;
  symbol: string;
  records: AnnotationRecord[];
}

function extractTitle(content: string): string {
  const clean = content.replace(
    /^(session records suggest:|inferred from documentation:|conflicting records exist:)\s*/i,
    "",
  );
  const first = clean.split(/[.!?]/)[0]?.trim() ?? "";
  if (first.length <= 80) return first || clean.slice(0, 80);
  return first.slice(0, 77) + "...";
}

function extractSummary(content: string): string {
  const clean = content.replace(
    /^(session records suggest:|inferred from documentation:|conflicting records exist:)\s*/i,
    "",
  );
  if (clean.length <= 120) return clean;
  return clean.slice(0, 117) + "...";
}

function extractSeverity(content: string): string | undefined {
  const m = content.match(/\[(critical|high|medium|low)\]/i);
  return m?.[1]?.toLowerCase();
}

// ---------------------------------------------------------------------------
// Symbol location extraction — best-effort pattern matching, no AST
// ---------------------------------------------------------------------------

export function getSymbolLocations(filePath: string): SymbolLocation[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const lines = content.split("\n");
  const ext = extname(filePath).toLowerCase();
  const isTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext);
  const isPy = ext === ".py";
  const isGo = ext === ".go";

  const starts: Array<{ symbol: string; start_line: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNum = i + 1;

    if (isTS) {
      let m: RegExpMatchArray | null;

      // export async function NAME / function NAME
      m = line.match(
        /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[(<]/,
      );
      if (m) { starts.push({ symbol: m[1]!, start_line: lineNum }); continue; }

      // export class NAME / abstract class NAME
      m = line.match(/^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      if (m) { starts.push({ symbol: m[1]!, start_line: lineNum }); continue; }

      // export const NAME = async function / async ( / arrow
      m = line.match(
        /^(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:function|\(|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)/,
      );
      if (m) { starts.push({ symbol: m[1]!, start_line: lineNum }); continue; }

      // export interface NAME / export type NAME
      m = line.match(/^(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      if (m) { starts.push({ symbol: m[1]!, start_line: lineNum }); continue; }

      // method inside class: optional leading whitespace, async NAME( or NAME(
      m = line.match(/^\s{2,}(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
      if (m) {
        const name = m[1]!;
        if (!["if", "for", "while", "switch", "catch", "super", "return"].includes(name)) {
          starts.push({ symbol: name, start_line: lineNum });
          continue;
        }
      }
    } else if (isPy) {
      let m: RegExpMatchArray | null;
      m = line.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      if (m) { starts.push({ symbol: m[1]!, start_line: lineNum }); continue; }
      m = line.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (m) { starts.push({ symbol: m[1]!, start_line: lineNum }); continue; }
    } else if (isGo) {
      let m: RegExpMatchArray | null;
      m = line.match(/^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      if (m) { starts.push({ symbol: m[1]!, start_line: lineNum }); continue; }
      m = line.match(/^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)/);
      if (m) { starts.push({ symbol: m[1]!, start_line: lineNum }); continue; }
    }
  }

  const locations: SymbolLocation[] = [];
  for (let i = 0; i < starts.length; i++) {
    const curr = starts[i]!;
    const next = starts[i + 1];
    const end_line = next
      ? Math.max(curr.start_line, next.start_line - 1)
      : Math.min(curr.start_line + 30, lines.length);
    locations.push({ symbol: curr.symbol, file: filePath, start_line: curr.start_line, end_line });
  }

  return locations;
}

// ---------------------------------------------------------------------------
// Provenance chain — ordered list of record IDs influencing a record
// ---------------------------------------------------------------------------

export async function buildProvenanceChain(
  record: Record<string, unknown>,
  repo: string,
): Promise<string[]> {
  const symbol = record["symbol"] as string | undefined;
  if (!symbol) return [String(record["id"] ?? "")];

  const data = await getReasoningData(symbol, repo);
  const all = [
    ...data.decisions,
    ...data.risks,
    ...data.deferred,
  ] as Record<string, unknown>[];

  all.sort((a, b) => Number(a["created_at"] ?? 0) - Number(b["created_at"] ?? 0));
  return all.map((r) => String(r["id"] ?? "")).filter(Boolean);
}

// ---------------------------------------------------------------------------
// getAnnotationsForFile — primary entry point
// ---------------------------------------------------------------------------

export async function getAnnotationsForFile(
  filePath: string,
  repo: string,
): Promise<Annotation[]> {
  const locations = getSymbolLocations(filePath);
  if (locations.length === 0) return [];

  const annotationMap = new Map<number, Annotation>();

  for (const loc of locations) {
    const data = await getReasoningData(loc.symbol, repo);

    // Sessions whose summary mentions this symbol
    const sessionRes = await sessionsDb.execute({
      sql: `SELECT id, summary, ended_at FROM sessions
            WHERE repo = ? AND summary LIKE ? AND status = 'complete'
            ORDER BY ended_at DESC LIMIT 3`,
      args: [repo, `%${loc.symbol}%`],
    });

    const records: AnnotationRecord[] = [];

    for (const d of data.decisions as Record<string, unknown>[]) {
      const chain = await buildProvenanceChain(d, repo);
      records.push({
        id: String(d["id"] ?? ""),
        type: "decision",
        title: extractTitle(String(d["content"] ?? "")),
        summary: extractSummary(String(d["content"] ?? "")),
        full: String(d["content"] ?? ""),
        confidence: String(d["confidence"] ?? "extracted"),
        session_id: d["session_id"] != null ? String(d["session_id"]) : undefined,
        chain,
      });
    }

    for (const r of data.risks as Record<string, unknown>[]) {
      const chain = await buildProvenanceChain(r, repo);
      records.push({
        id: String(r["id"] ?? ""),
        type: "risk",
        title: extractTitle(String(r["content"] ?? "")),
        summary: extractSummary(String(r["content"] ?? "")),
        full: String(r["content"] ?? ""),
        confidence: String(r["confidence"] ?? "extracted"),
        severity: extractSeverity(String(r["content"] ?? "")),
        session_id: r["session_id"] != null ? String(r["session_id"]) : undefined,
        chain,
      });
    }

    for (const dw of data.deferred as Record<string, unknown>[]) {
      const chain = await buildProvenanceChain(dw, repo);
      records.push({
        id: String(dw["id"] ?? ""),
        type: "deferred",
        title: extractTitle(String(dw["content"] ?? "")),
        summary: extractSummary(String(dw["content"] ?? "")),
        full: String(dw["content"] ?? ""),
        confidence: String(dw["confidence"] ?? "extracted"),
        session_id: dw["session_id"] != null ? String(dw["session_id"]) : undefined,
        chain,
      });
    }

    for (const row of sessionRes.rows) {
      const sr = row as Record<string, unknown>;
      const summary = String(sr["summary"] ?? "");
      if (!summary) continue;
      records.push({
        id: String(sr["id"] ?? ""),
        type: "session",
        title: `Session: ${new Date(Number(sr["ended_at"] ?? 0)).toISOString().slice(0, 10)}`,
        summary: summary.length > 120 ? summary.slice(0, 117) + "..." : summary,
        full: summary,
        confidence: "extracted",
        chain: [],
      });
    }

    if (records.length === 0) continue;

    const line = loc.start_line;
    if (!annotationMap.has(line)) {
      annotationMap.set(line, { line, symbol: loc.symbol, records: [] });
    }
    annotationMap.get(line)!.records.push(...records);
  }

  return Array.from(annotationMap.values()).sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------
// Coverage stats
// ---------------------------------------------------------------------------

export interface CoverageStats {
  total_symbols: number;
  annotated_symbols: number;
  coverage_pct: number;
  unannotated: string[];
}

export async function getAnnotationCoverage(
  filePaths: string[],
  repo: string,
): Promise<CoverageStats> {
  const allSymbols = new Set<string>();
  const annotatedSymbols = new Set<string>();
  const unannotated: string[] = [];

  for (const fp of filePaths) {
    const locs = getSymbolLocations(fp);
    for (const loc of locs) {
      allSymbols.add(loc.symbol);
      const data = await getReasoningData(loc.symbol, repo);
      const hasRecords =
        data.decisions.length > 0 || data.risks.length > 0 || data.deferred.length > 0;
      if (hasRecords) {
        annotatedSymbols.add(loc.symbol);
      } else {
        unannotated.push(loc.symbol);
      }
    }
  }

  const total = allSymbols.size;
  const annotated = annotatedSymbols.size;
  return {
    total_symbols: total,
    annotated_symbols: annotated,
    coverage_pct: total > 0 ? Math.round((annotated / total) * 100) : 0,
    unannotated: [...new Set(unannotated)],
  };
}
