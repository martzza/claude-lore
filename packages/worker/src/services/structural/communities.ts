import { createHash } from "crypto";
import type { Client } from "@libsql/client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STDLIB_NAMES = new Set([
  'join', 'resolve', 'has', 'get', 'set', 'now', 'log',
  'push', 'map', 'filter', 'find', 'includes', 'split',
  'keys', 'values', 'entries', 'assign', 'create', 'from',
  'parse', 'stringify', 'toString', 'valueOf', 'call', 'apply',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Community {
  id:          string;
  name:        string;      // auto-generated from dominant symbols/files
  symbols:     string[];
  files:       string[];
  size:        number;
  hub_symbol?: string;      // most-connected symbol in community
  description: string;      // auto-generated summary
}

// ---------------------------------------------------------------------------
// Community detection — BFS-based connected components on the call graph
// ---------------------------------------------------------------------------

export async function detectCommunities(
  db: Client,
  minSize: number = 3,
): Promise<Community[]> {

  // Load all call edges (calls only, not test_covers)
  const edges = await db.execute(
    `SELECT DISTINCT caller, callee FROM call_graph WHERE kind = 'calls'`,
  );

  // Build undirected adjacency map
  const adj = new Map<string, Set<string>>();
  for (const row of edges.rows) {
    const caller = String(row["caller"]);
    const callee = String(row["callee"]);

    if (!adj.has(caller)) adj.set(caller, new Set());
    if (!adj.has(callee)) adj.set(callee, new Set());
    adj.get(caller)!.add(callee);
    adj.get(callee)!.add(caller); // undirected for clustering
  }

  // Load all non-test symbol names + files
  const symbolRows = await db.execute(
    `SELECT name, file FROM symbols WHERE is_test = 0`,
  );
  const symbolFiles = new Map<string, string>();
  for (const row of symbolRows.rows) {
    symbolFiles.set(String(row["name"]), String(row["file"]));
  }

  // BFS connected-components
  const visited = new Set<string>();
  const communities: Community[] = [];

  for (const symbol of adj.keys()) {
    if (visited.has(symbol)) continue;

    const community = new Set<string>();
    const queue = [symbol];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      community.add(current);

      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor) && symbolFiles.has(neighbor)) {
          queue.push(neighbor);
        }
      }
    }

    if (community.size < minSize) continue;

    const symbols = [...community];

    // Hub symbol = highest undirected degree within this community
    let maxDegree = 0;
    let hubSymbol = symbols[0]!;
    for (const s of symbols) {
      const degree = adj.get(s)?.size ?? 0;
      if (degree > maxDegree) {
        maxDegree = degree;
        hubSymbol = s;
      }
    }

    // Unique files
    const files = [...new Set(
      symbols.map((s) => symbolFiles.get(s)).filter(Boolean) as string[],
    )];

    const name = inferCommunityName(files, symbols, hubSymbol);

    communities.push({
      id:          generateCommunityId(symbols),
      name,
      symbols,
      files,
      size:        symbols.length,
      hub_symbol:  hubSymbol,
      description: generateDescription(name, symbols, files),
    });
  }

  // Deduplicate community names using hub symbol as suffix
  const usedNames = new Map<string, number>();

  for (const community of communities) {
    const baseName = community.name;
    const count    = usedNames.get(baseName) ?? 0;

    if (count > 0) {
      const hubSuffix = community.hub_symbol
        ? community.hub_symbol
            .replace(/([A-Z])/g, '-$1')
            .toLowerCase()
            .replace(/^-/, '')
            .split('-')
            .find(w => w.length > 3 && !STDLIB_NAMES.has(w))
        : String(count + 1);

      community.name = baseName + '-' + (hubSuffix ?? count + 1);
    }

    usedNames.set(baseName, count + 1);
  }

  return communities.sort((a, b) => b.size - a.size);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferCommunityName(files: string[], symbols: string[], hubSymbol: string): string {
  if (files.length === 0) return "unknown";

  // Find common directory prefix
  const parts = files.map((f) => f.split("/"));
  const minLen = Math.min(...parts.map((p) => p.length));

  const commonParts: string[] = [];
  for (let i = 0; i < minLen - 1; i++) {
    const segment = parts[0]![i];
    if (parts.every((p) => p[i] === segment)) {
      commonParts.push(segment!);
    } else {
      break;
    }
  }

  if (commonParts.length > 0) {
    const relevant = commonParts.filter(
      (p) => !["src", "packages", "lib", "dist", "."].includes(p) && !STDLIB_NAMES.has(p),
    );
    if (relevant.length > 0) return relevant[relevant.length - 1]!;
  }

  // Fall back to most common word in symbol names
  const words = symbols
    .flatMap((s) => s.replace(/([A-Z])/g, " $1").toLowerCase().split(/\W+/))
    .filter((w) => w.length > 3 && !STDLIB_NAMES.has(w));

  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  const topWord = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
  const inferredName = topWord ? topWord[0] : "community";

  // If the inferred name matches a stdlib function, fall back to hub symbol words
  if (STDLIB_NAMES.has(inferredName)) {
    const hubWords = hubSymbol
      .replace(/([A-Z])/g, ' $1')
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3 && !STDLIB_NAMES.has(w));
    if (hubWords.length > 0) return hubWords[0]!;
    return hubSymbol.slice(0, 12);
  }

  return inferredName;
}

function generateCommunityId(symbols: string[]): string {
  const sorted = [...symbols].sort().join(",");
  return createHash("md5").update(sorted).digest("hex").slice(0, 8);
}

function generateDescription(
  name:    string,
  symbols: string[],
  files:   string[],
): string {
  const preview = symbols.slice(0, 3).join(", ");
  const more    = symbols.length > 3 ? ` and ${symbols.length - 3} more` : "";
  return `${name} module: ${symbols.length} symbols across ${files.length} file${files.length !== 1 ? "s" : ""}. ` +
    `Core symbols: ${preview}${more}`;
}
