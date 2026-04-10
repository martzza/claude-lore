import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, isAbsolute } from "path";

const BASE_URL = "http://127.0.0.1:37778";

interface WikiPage {
  community_id:   string;
  community_name: string;
  description:    string;
  hub_symbol:     string | null;
  size:           number;
  files:          string[];
  symbols:        Array<{ name: string; file: string; kind: string; exported: boolean; is_test: boolean; start_line: number; line: number }>;
  decisions:      Array<{ id: string; content: string; confidence: string; symbol: string | null }>;
  risks:          Array<{ id: string; content: string; confidence: string; symbol: string | null }>;
  deferred:       Array<{ id: string; content: string; confidence: string; symbol: string | null; status: string }>;
  coverage_pct:   number;
  generated_at:   number;
}

interface WikiResponse {
  communities:   number;
  total_symbols: number;
  generated_at:  number;
  pages:         WikiPage[];
}

function renderIndexMarkdown(pages: WikiPage[]): string {
  const ts = new Date().toISOString().split("T")[0];
  const lines: string[] = [
    "# Codebase Wiki — Index",
    "",
    `> Generated ${ts} · ${pages.length} communities`,
    "",
    "| Community | Symbols | Coverage | Hub | Decisions | Risks |",
    "|-----------|---------|----------|-----|-----------|-------|",
  ];
  for (const page of pages) {
    const hub = page.hub_symbol ? `\`${page.hub_symbol}\`` : "—";
    lines.push(
      `| [${page.community_name}](./${page.community_id}.md) | ${page.size} | ${page.coverage_pct}% | ${hub} | ${page.decisions.length} | ${page.risks.length} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderPageMarkdown(page: WikiPage): string {
  const lines: string[] = [];
  const ts = new Date(page.generated_at).toISOString().split("T")[0];

  lines.push(`# ${page.community_name}`);
  lines.push("");
  lines.push(`> Community \`${page.community_id}\` · ${page.size} symbols · ${page.coverage_pct}% test coverage · generated ${ts}`);
  if (page.hub_symbol) lines.push(`> Hub symbol: \`${page.hub_symbol}\``);
  lines.push("");

  lines.push("## Files");
  lines.push("");
  for (const f of page.files.slice(0, 20)) lines.push(`- \`${f}\``);
  if (page.files.length > 20) lines.push(`- *(${page.files.length - 20} more)*`);
  lines.push("");

  if (page.decisions.length > 0) {
    lines.push("## Decisions");
    lines.push("");
    for (const d of page.decisions.slice(0, 10)) {
      const badge = d.confidence === "confirmed" ? "✓" : d.confidence === "extracted" ? "~" : "?";
      const summary = d.content.split("\n")[0]!.trim().slice(0, 120);
      const sym = d.symbol ? ` \`[${d.symbol}]\`` : "";
      lines.push(`**${badge}**${sym} ${summary}`);
      lines.push(`<sub>id: ${d.id} · ${d.confidence}</sub>`);
      lines.push("");
    }
  }

  if (page.risks.length > 0) {
    lines.push("## Risks");
    lines.push("");
    for (const r of page.risks.slice(0, 10)) {
      const badge = r.confidence === "confirmed" ? "✓" : r.confidence === "extracted" ? "~" : "?";
      const summary = r.content.split("\n")[0]!.trim().slice(0, 120);
      const sym = r.symbol ? ` \`[${r.symbol}]\`` : "";
      lines.push(`**${badge}**${sym} ${summary}`);
      lines.push(`<sub>id: ${r.id} · ${r.confidence}</sub>`);
      lines.push("");
    }
  }

  if (page.deferred.length > 0) {
    lines.push("## Open deferred work");
    lines.push("");
    for (const d of page.deferred) {
      const summary = d.content.split("\n")[0]!.trim().slice(0, 120);
      const sym = d.symbol ? ` \`[${d.symbol}]\`` : "";
      lines.push(`- [ ]${sym} ${summary} <sub>id: ${d.id}</sub>`);
    }
    lines.push("");
  }

  lines.push("## Symbols");
  lines.push("");
  lines.push("| Symbol | File | Kind | Exported | Test |");
  lines.push("|--------|------|------|----------|------|");
  for (const sym of page.symbols.slice(0, 50)) {
    const line = sym.line ?? sym.start_line;
    lines.push(`| \`${sym.name}\` | \`${sym.file}:${line}\` | ${sym.kind} | ${sym.exported ? "✓" : ""} | ${sym.is_test ? "✓" : ""} |`);
  }
  if (page.symbols.length > 50) lines.push(`| *(${page.symbols.length - 50} more)* | | | | |`);
  lines.push("");

  return lines.join("\n");
}

export async function runWiki(opts: {
  community?: string;
  format?:    "md" | "html";
  output?:    string;
  open?:      boolean;
}): Promise<void> {
  const cwd = process.cwd();

  // Validate structural index exists
  if (!existsSync(join(cwd, ".codegraph", "structural.db"))) {
    console.error("✗ Structural index not found. Run: claude-lore index");
    process.exit(1);
  }

  // Default: HTML + open browser (unless --format md is explicit)
  const wantsMarkdown = opts.format === "md";

  // --output dir: write HTML files (or md if --format md)
  if (opts.output) {
    const params = new URLSearchParams({ cwd, repo: cwd, format: "json" });
    if (opts.community) params.set("community", opts.community);

    let data: WikiResponse | { community: WikiPage | null };
    try {
      const res = await fetch(`${BASE_URL}/api/structural/wiki?${params}`);
      if (!res.ok) {
        const body = await res.text();
        console.error(`✗ Worker error (${res.status}):`, body);
        process.exit(1);
      }
      data = await res.json() as typeof data;
    } catch (err) {
      console.error("✗ Could not reach worker:", err);
      console.error("  Is the worker running? Try: claude-lore worker start");
      process.exit(1);
    }

    let pages: WikiPage[];
    if ("community" in data) {
      if (!data.community) {
        console.error(`✗ Community '${opts.community}' not found.`);
        process.exit(1);
      }
      pages = [data.community];
    } else {
      pages = data.pages;
    }

    const dir = isAbsolute(opts.output) ? opts.output : join(cwd, opts.output);
    mkdirSync(dir, { recursive: true });

    if (wantsMarkdown) {
      writeFileSync(join(dir, "index.md"), renderIndexMarkdown(pages), "utf8");
      for (const page of pages) {
        writeFileSync(join(dir, `${page.community_id}.md`), renderPageMarkdown(page), "utf8");
      }
      console.log(`✓ Wiki written to ${dir}/`);
      console.log(`  index.md + ${pages.length} community page${pages.length !== 1 ? "s" : ""}`);
      if (opts.open) {
        const { execSync } = await import("child_process");
        try { execSync(`open ${JSON.stringify(join(dir, "index.md"))}`); } catch { /* ok */ }
      }
    } else {
      // Fetch HTML from worker
      const htmlParams = new URLSearchParams({ cwd, repo: cwd, format: "html" });
      const htmlRes = await fetch(`${BASE_URL}/api/structural/wiki?${htmlParams}`);
      const html = await htmlRes.text();
      writeFileSync(join(dir, "index.html"), html, "utf8");
      console.log(`✓ Wiki written to ${join(dir, "index.html")}`);
      if (opts.open) {
        const { execSync } = await import("child_process");
        try { execSync(`open ${JSON.stringify(join(dir, "index.html"))}`); } catch { /* ok */ }
      }
    }
    return;
  }

  // Markdown stdout mode: --format md
  if (wantsMarkdown) {
    const params = new URLSearchParams({ cwd, repo: cwd, format: "json" });
    if (opts.community) params.set("community", opts.community);

    let data: WikiResponse | { community: WikiPage | null };
    try {
      const res = await fetch(`${BASE_URL}/api/structural/wiki?${params}`);
      if (!res.ok) {
        const body = await res.text();
        console.error(`✗ Worker error (${res.status}):`, body);
        process.exit(1);
      }
      data = await res.json() as typeof data;
    } catch (err) {
      console.error("✗ Could not reach worker:", err);
      console.error("  Is the worker running? Try: claude-lore worker start");
      process.exit(1);
    }

    let pages: WikiPage[];
    if ("community" in data) {
      if (!data.community) {
        console.error(`✗ Community '${opts.community}' not found.`);
        process.exit(1);
      }
      pages = [data.community];
    } else {
      pages = data.pages;
    }

    if (opts.community) {
      process.stdout.write(renderPageMarkdown(pages[0]!));
    } else {
      process.stdout.write(renderIndexMarkdown(pages));
      process.stdout.write("\n");
      for (const page of pages) {
        process.stdout.write("\n---\n\n");
        process.stdout.write(renderPageMarkdown(page));
      }
    }
    return;
  }

  // Default: HTML → open worker URL in browser (bookmarkable, stays live)
  const wikiParams = new URLSearchParams({ cwd, repo: cwd });
  if (opts.community) wikiParams.set("community", opts.community);
  const wikiUrl = `${BASE_URL}/wiki?${wikiParams}`;

  // Verify worker is reachable
  try {
    const probe = await fetch(wikiUrl, { signal: AbortSignal.timeout(3000) });
    if (!probe.ok) {
      console.error(`✗ Worker error (${probe.status}) — run: claude-lore worker start`);
      process.exit(1);
    }
  } catch {
    console.error("✗ Could not reach worker. Is it running? Try: claude-lore worker start");
    process.exit(1);
  }

  console.log(`✓ Wiki ready — opening in browser`);
  console.log(`  ${wikiUrl}`);

  const { execSync } = await import("child_process");
  try { execSync(`open ${JSON.stringify(wikiUrl)}`); } catch { /* ok */ }
}
