import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, resolve, extname, dirname, relative, basename } from "path";
import { getReasoningData } from "../reasoning/service.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileDep {
  from: string;   // relative path
  to: string;     // relative path (resolved)
  raw: string;    // original import specifier
  kind: "import" | "require" | "dynamic";
}

export interface FileNode {
  path: string;       // relative path from cwd
  abs: string;        // absolute path
  depth: number;      // BFS depth from entry points (0 = entry point)
  deps: string[];     // relative paths this file imports
  dependents: string[]; // relative paths that import this file
  size_bytes: number;
  ext: string;
}

export interface DepGraph {
  nodes: FileNode[];
  edges: FileDep[];
  entry_points: string[];  // relative paths of root nodes (depth 0)
  cwd: string;
}

export interface EnrichedRecord {
  id: string;
  type: "decision" | "risk" | "deferred_work";
  content: string;
  confidence: string;
  symbol?: string;
}

export interface EnrichedFileNode extends FileNode {
  decision_count: number;
  risk_count: number;
  deferred_count: number;
  annotation_count: number;
  has_reasoning: boolean;
  records: EnrichedRecord[];
  source_lines: string[];  // first 100 lines, for panel code viewer
}

export interface EnrichedDepGraph {
  nodes: EnrichedFileNode[];
  edges: FileDep[];
  entry_points: string[];
  cwd: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

const IGNORE_DIRS = new Set([
  "node_modules", "dist", ".git", ".codegraph", "coverage",
  "__tests__", ".turbo", ".cache", "build",
]);

// Regex patterns to extract imports/requires
const IMPORT_RE = /^\s*import\s+(?:type\s+)?(?:.*?\s+from\s+)?['"]([^'"]+)['"]/gm;
const REQUIRE_RE = /(?:require|require\.resolve)\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
const DYNAMIC_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function discoverFiles(cwd: string): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry)) continue;
      const abs = join(dir, entry);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        walk(abs);
      } else if (SOURCE_EXTS.has(extname(entry))) {
        files.push(abs);
      }
    }
  }

  walk(cwd);
  return files;
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

function extractImports(content: string): Array<{ specifier: string; kind: "import" | "require" | "dynamic" }> {
  const results: Array<{ specifier: string; kind: "import" | "require" | "dynamic" }> = [];
  const seen = new Set<string>();

  const add = (specifier: string, kind: "import" | "require" | "dynamic") => {
    if (!seen.has(specifier)) {
      seen.add(specifier);
      results.push({ specifier, kind });
    }
  };

  let m: RegExpExecArray | null;

  const importRe = new RegExp(IMPORT_RE.source, "gm");
  while ((m = importRe.exec(content)) !== null) {
    if (m[1]) add(m[1], "import");
  }

  const requireRe = new RegExp(REQUIRE_RE.source, "gm");
  while ((m = requireRe.exec(content)) !== null) {
    if (m[1]) add(m[1], "require");
  }

  const dynamicRe = new RegExp(DYNAMIC_RE.source, "gm");
  while ((m = dynamicRe.exec(content)) !== null) {
    if (m[1]) add(m[1], "dynamic");
  }

  return results;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolveSpecifier(specifier: string, fromAbs: string, cwd: string): string | null {
  // Skip external packages (no leading . or /)
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;

  const fromDir = dirname(fromAbs);
  let candidate = resolve(fromDir, specifier);

  // Strip .js extension and try .ts variants (common in TS projects)
  if (candidate.endsWith(".js")) {
    const tsVariant = candidate.slice(0, -3) + ".ts";
    if (existsSync(tsVariant)) return relative(cwd, tsVariant);
    const tsxVariant = candidate.slice(0, -3) + ".tsx";
    if (existsSync(tsxVariant)) return relative(cwd, tsxVariant);
  }

  // Direct match
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return relative(cwd, candidate);
  }

  // Try adding extensions
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs"]) {
    const withExt = candidate + ext;
    if (existsSync(withExt)) return relative(cwd, withExt);
  }

  // Try index file
  for (const idx of ["index.ts", "index.tsx", "index.js", "index.jsx"]) {
    const indexPath = join(candidate, idx);
    if (existsSync(indexPath)) return relative(cwd, indexPath);
  }

  return null;
}

// ---------------------------------------------------------------------------
// BFS depth assignment
// ---------------------------------------------------------------------------

function assignDepths(
  nodes: Map<string, FileNode>,
  edges: FileDep[],
): string[] {
  // Build reverse adjacency (dependents)
  const dependents = new Map<string, Set<string>>();
  for (const node of nodes.values()) {
    dependents.set(node.path, new Set());
  }
  for (const edge of edges) {
    const set = dependents.get(edge.to);
    if (set) set.add(edge.from);
  }

  // Entry points: files with no dependents (nothing imports them)
  const entryPoints: string[] = [];
  for (const [path, deps] of dependents.entries()) {
    if (deps.size === 0) {
      entryPoints.push(path);
    }
  }

  // BFS from entry points
  const queue: Array<{ path: string; depth: number }> = [];
  for (const ep of entryPoints) {
    const node = nodes.get(ep);
    if (node) {
      node.depth = 0;
      queue.push({ path: ep, depth: 0 });
    }
  }

  const visited = new Set<string>(entryPoints);

  while (queue.length > 0) {
    const item = queue.shift()!;
    const node = nodes.get(item.path);
    if (!node) continue;
    for (const dep of node.deps) {
      if (!visited.has(dep)) {
        visited.add(dep);
        const depNode = nodes.get(dep);
        if (depNode) {
          depNode.depth = item.depth + 1;
          queue.push({ path: dep, depth: item.depth + 1 });
        }
      }
    }
  }

  // Files not reachable from entry points stay at depth -1
  return entryPoints;
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export async function buildDepGraph(repo: string, cwd: string): Promise<DepGraph> {
  const absFiles = discoverFiles(cwd);
  const edges: FileDep[] = [];

  const nodes = new Map<string, FileNode>();

  // First pass: create all nodes
  for (const abs of absFiles) {
    const rel = relative(cwd, abs);
    let size = 0;
    try { size = statSync(abs).size; } catch { /* ok */ }
    nodes.set(rel, {
      path: rel,
      abs,
      depth: -1,
      deps: [],
      dependents: [],
      size_bytes: size,
      ext: extname(abs),
    });
  }

  // Second pass: extract imports and build edges
  for (const abs of absFiles) {
    const rel = relative(cwd, abs);
    let content = "";
    try { content = readFileSync(abs, "utf8"); } catch { continue; }

    const imports = extractImports(content);
    for (const { specifier, kind } of imports) {
      const resolved = resolveSpecifier(specifier, abs, cwd);
      if (resolved && nodes.has(resolved)) {
        edges.push({ from: rel, to: resolved, raw: specifier, kind });
        const fromNode = nodes.get(rel)!;
        if (!fromNode.deps.includes(resolved)) fromNode.deps.push(resolved);
        const toNode = nodes.get(resolved)!;
        if (!toNode.dependents.includes(rel)) toNode.dependents.push(rel);
      }
    }
  }

  const entryPoints = assignDepths(nodes, edges);

  return {
    nodes: Array.from(nodes.values()),
    edges,
    entry_points: entryPoints,
    cwd,
  };
}

// ---------------------------------------------------------------------------
// Enrichment: attach reasoning record counts per file
// ---------------------------------------------------------------------------

export async function enrichDepGraph(graph: DepGraph, repo: string): Promise<EnrichedDepGraph> {
  const enriched: EnrichedFileNode[] = await Promise.all(
    graph.nodes.map(async (node) => {
      // Read source lines (capped at 100 for panel viewer)
      let source_lines: string[] = [];
      try {
        const content = readFileSync(node.abs, "utf8");
        source_lines = content.split("\n").slice(0, 100);
      } catch { /* ok */ }

      try {
        const data = await getReasoningData(undefined, repo);
        const filePath = node.path;
        const fileBase = basename(filePath, extname(filePath));

        type RawRecord = Record<string, unknown>;
        const tag = (type: "decision" | "risk" | "deferred_work") =>
          (r: RawRecord): RawRecord & { type: string } => ({ ...r, type });

        const allRecords: (RawRecord & { type: string })[] = [
          ...(data.decisions ?? []).map(tag("decision")),
          ...(data.risks ?? []).map(tag("risk")),
          ...(data.deferred ?? []).map(tag("deferred_work")),
        ];

        const relevant = allRecords.filter((r) => {
          const content = String(r["content"] ?? "");
          const symbol = String(r["symbol"] ?? "");
          return content.includes(filePath) || symbol.includes(fileBase);
        });

        const records: EnrichedRecord[] = relevant.map((r) => ({
          id: String(r["id"] ?? ""),
          type: r["type"] as "decision" | "risk" | "deferred_work",
          content: String(r["content"] ?? ""),
          confidence: String(r["confidence"] ?? "extracted"),
          symbol: r["symbol"] ? String(r["symbol"]) : undefined,
        }));

        return {
          ...node,
          decision_count: relevant.filter(r => r["type"] === "decision").length,
          risk_count: relevant.filter(r => r["type"] === "risk").length,
          deferred_count: relevant.filter(r => r["type"] === "deferred_work").length,
          annotation_count: relevant.length,
          has_reasoning: relevant.length > 0,
          records,
          source_lines,
        };
      } catch {
        return {
          ...node,
          decision_count: 0,
          risk_count: 0,
          deferred_count: 0,
          annotation_count: 0,
          has_reasoning: false,
          records: [],
          source_lines,
        };
      }
    }),
  );

  return {
    nodes: enriched,
    edges: graph.edges,
    entry_points: graph.entry_points,
    cwd: graph.cwd,
  };
}
