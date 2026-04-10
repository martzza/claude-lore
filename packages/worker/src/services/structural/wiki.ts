import { Client } from "@libsql/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiSymbol {
  name: string;
  file: string;
  kind: string;
  exported: boolean;
  is_test: boolean;
  start_line: number;
}

export interface WikiDecision {
  id: string;
  content: string;
  confidence: string;
  symbol: string | null;
  created_at: number;
}

export interface WikiRisk {
  id: string;
  content: string;
  confidence: string;
  symbol: string | null;
  created_at: number;
}

export interface WikiDeferred {
  id: string;
  content: string;
  confidence: string;
  symbol: string | null;
  status: string;
  created_at: number;
}

export interface WikiPage {
  community_id: string;
  community_name: string;
  hub_symbol: string | null;
  size: number;
  files: string[];
  symbols: WikiSymbol[];
  decisions: WikiDecision[];
  risks: WikiRisk[];
  deferred: WikiDeferred[];
  coverage_pct: number;    // % of symbols covered by tests
  generated_at: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstLine(text: string): string {
  return text.split("\n")[0].trim();
}

function confidenceBadge(confidence: string): string {
  switch (confidence) {
    case "confirmed": return "✓";
    case "extracted": return "~";
    case "inferred":  return "?";
    default:          return "·";
  }
}

// ---------------------------------------------------------------------------
// Generate wiki pages for all communities
// ---------------------------------------------------------------------------

export async function generateWiki(
  structDb: Client,
  reasonDb: Client,
  repo: string,
): Promise<WikiPage[]> {
  // Fetch all communities
  const commResult = await structDb.execute(
    "SELECT id, name, hub_symbol, size, files, symbols FROM communities ORDER BY size DESC"
  );

  const pages: WikiPage[] = [];

  for (const row of commResult.rows) {
    const communityId   = row[0] as string;
    const communityName = row[1] as string;
    const hubSymbol     = row[2] as string | null;
    const size          = row[3] as number;
    const filesJson     = row[4] as string;
    const symbolsJson   = row[5] as string;

    const files: string[]         = JSON.parse(filesJson);
    const symbolNames: string[]   = JSON.parse(symbolsJson);

    // Fetch symbol details from structural DB
    if (symbolNames.length === 0) continue;

    const placeholders = symbolNames.map(() => "?").join(",");
    const symResult = await structDb.execute({
      sql: `SELECT name, file, kind, exported, is_test, start_line
            FROM symbols
            WHERE name IN (${placeholders})
            ORDER BY file, start_line`,
      args: symbolNames,
    });

    const symbols: WikiSymbol[] = symResult.rows.map(r => ({
      name:       r[0] as string,
      file:       r[1] as string,
      kind:       r[2] as string,
      exported:   Boolean(r[3]),
      is_test:    Boolean(r[4]),
      start_line: r[5] as number,
    }));

    // Count test coverage
    const covResult = await structDb.execute({
      sql: `SELECT COUNT(DISTINCT cg.callee)
            FROM call_graph cg
            WHERE cg.kind = 'test_covers'
              AND cg.callee IN (${placeholders})`,
      args: symbolNames,
    });
    const coveredCount = (covResult.rows[0]?.[0] as number) ?? 0;
    const productionSymbols = symbols.filter(s => !s.is_test).length;
    const coverage_pct = productionSymbols > 0
      ? Math.round((coveredCount / productionSymbols) * 100)
      : 0;

    // Fetch reasoning records from sessions DB, matched by symbol or file
    // Match by symbol name (in community) or by file path segments
    const fileMatches = files.map(f => `%${f}%`);

    // Decisions
    const decisions: WikiDecision[] = [];
    {
      // By symbol name
      if (symbolNames.length > 0) {
        const r = await reasonDb.execute({
          sql: `SELECT id, content, confidence, symbol, created_at
                FROM decisions
                WHERE repo = ?
                  AND lifecycle_status = 'active'
                  AND symbol IN (${placeholders})
                ORDER BY created_at DESC
                LIMIT 20`,
          args: [repo, ...symbolNames],
        });
        for (const row of r.rows) {
          decisions.push({
            id: row[0] as string,
            content: row[1] as string,
            confidence: row[2] as string,
            symbol: row[3] as string | null,
            created_at: row[4] as number,
          });
        }
      }
      // Also by null symbol (repo-wide) limited to 5
      const r2 = await reasonDb.execute({
        sql: `SELECT id, content, confidence, symbol, created_at
              FROM decisions
              WHERE repo = ?
                AND lifecycle_status = 'active'
                AND symbol IS NULL
                AND confidence = 'confirmed'
              ORDER BY created_at DESC
              LIMIT 5`,
        args: [repo],
      });
      for (const row of r2.rows) {
        if (!decisions.find(d => d.id === (row[0] as string))) {
          decisions.push({
            id: row[0] as string,
            content: row[1] as string,
            confidence: row[2] as string,
            symbol: row[3] as string | null,
            created_at: row[4] as number,
          });
        }
      }
    }

    // Risks
    const risks: WikiRisk[] = [];
    {
      if (symbolNames.length > 0) {
        const r = await reasonDb.execute({
          sql: `SELECT id, content, confidence, symbol, created_at
                FROM risks
                WHERE repo = ?
                  AND lifecycle_status = 'active'
                  AND symbol IN (${placeholders})
                ORDER BY
                  CASE confidence WHEN 'confirmed' THEN 0 WHEN 'extracted' THEN 1 ELSE 2 END,
                  created_at DESC
                LIMIT 15`,
          args: [repo, ...symbolNames],
        });
        for (const row of r.rows) {
          risks.push({
            id: row[0] as string,
            content: row[1] as string,
            confidence: row[2] as string,
            symbol: row[3] as string | null,
            created_at: row[4] as number,
          });
        }
      }
    }

    // Deferred work
    const deferred: WikiDeferred[] = [];
    {
      if (symbolNames.length > 0) {
        const r = await reasonDb.execute({
          sql: `SELECT id, content, confidence, symbol, status, created_at
                FROM deferred_work
                WHERE repo = ?
                  AND lifecycle_status = 'active'
                  AND status = 'open'
                  AND symbol IN (${placeholders})
                ORDER BY created_at DESC
                LIMIT 10`,
          args: [repo, ...symbolNames],
        });
        for (const row of r.rows) {
          deferred.push({
            id: row[0] as string,
            content: row[1] as string,
            confidence: row[2] as string,
            symbol: row[3] as string | null,
            status: row[4] as string,
            created_at: row[5] as number,
          });
        }
      }
    }

    pages.push({
      community_id: communityId,
      community_name: communityName,
      hub_symbol: hubSymbol,
      size,
      files,
      symbols,
      decisions,
      risks,
      deferred,
      coverage_pct,
      generated_at: Date.now(),
    });
  }

  return pages;
}

// ---------------------------------------------------------------------------
// Render a single wiki page as Markdown
// ---------------------------------------------------------------------------

export function renderWikiPageMarkdown(page: WikiPage): string {
  const lines: string[] = [];
  const ts = new Date(page.generated_at).toISOString().split("T")[0];

  lines.push(`# ${page.community_name}`);
  lines.push("");
  lines.push(`> Community \`${page.community_id}\` · ${page.size} symbols · ${page.coverage_pct}% test coverage · generated ${ts}`);
  if (page.hub_symbol) lines.push(`> Hub symbol: \`${page.hub_symbol}\``);
  lines.push("");

  // Files
  lines.push("## Files");
  lines.push("");
  for (const f of page.files.slice(0, 20)) {
    lines.push(`- \`${f}\``);
  }
  if (page.files.length > 20) lines.push(`- *(${page.files.length - 20} more)*`);
  lines.push("");

  // Decisions
  if (page.decisions.length > 0) {
    lines.push("## Decisions");
    lines.push("");
    for (const d of page.decisions.slice(0, 10)) {
      const badge = confidenceBadge(d.confidence);
      const summary = firstLine(d.content).slice(0, 120);
      const sym = d.symbol ? ` \`[${d.symbol}]\`` : "";
      lines.push(`**${badge}**${sym} ${summary}`);
      lines.push(`<sub>id: ${d.id} · ${d.confidence}</sub>`);
      lines.push("");
    }
  }

  // Risks
  if (page.risks.length > 0) {
    lines.push("## Risks");
    lines.push("");
    for (const r of page.risks.slice(0, 10)) {
      const badge = confidenceBadge(r.confidence);
      const summary = firstLine(r.content).slice(0, 120);
      const sym = r.symbol ? ` \`[${r.symbol}]\`` : "";
      lines.push(`**${badge}**${sym} ${summary}`);
      lines.push(`<sub>id: ${r.id} · ${r.confidence}</sub>`);
      lines.push("");
    }
  }

  // Deferred
  if (page.deferred.length > 0) {
    lines.push("## Open deferred work");
    lines.push("");
    for (const d of page.deferred) {
      const summary = firstLine(d.content).slice(0, 120);
      const sym = d.symbol ? ` \`[${d.symbol}]\`` : "";
      lines.push(`- [ ]${sym} ${summary} <sub>id: ${d.id}</sub>`);
    }
    lines.push("");
  }

  // Symbol table
  lines.push("## Symbols");
  lines.push("");
  lines.push("| Symbol | File | Kind | Exported | Test |");
  lines.push("|--------|------|------|----------|------|");
  for (const sym of page.symbols.slice(0, 50)) {
    const exp = sym.exported ? "✓" : "";
    const test = sym.is_test ? "✓" : "";
    lines.push(`| \`${sym.name}\` | \`${sym.file}:${sym.start_line}\` | ${sym.kind} | ${exp} | ${test} |`);
  }
  if (page.symbols.length > 50) {
    lines.push(`| *(${page.symbols.length - 50} more symbols)* | | | | |`);
  }
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Render index page listing all communities
// ---------------------------------------------------------------------------

export function renderWikiIndexMarkdown(pages: WikiPage[]): string {
  const lines: string[] = [];
  const ts = new Date().toISOString().split("T")[0];

  lines.push("# Codebase Wiki — Index");
  lines.push("");
  lines.push(`> Generated ${ts} · ${pages.length} communities`);
  lines.push("");
  lines.push("| Community | Symbols | Coverage | Hub | Decisions | Risks |");
  lines.push("|-----------|---------|----------|-----|-----------|-------|");

  for (const page of pages) {
    const hub = page.hub_symbol ? `\`${page.hub_symbol}\`` : "—";
    lines.push(
      `| [${page.community_name}](./${page.community_id}.md) | ${page.size} | ${page.coverage_pct}% | ${hub} | ${page.decisions.length} | ${page.risks.length} |`
    );
  }
  lines.push("");

  return lines.join("\n");
}
