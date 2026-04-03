import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "fs";
import { join, isAbsolute, resolve, relative, extname } from "path";
import { createClient } from "@libsql/client";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { getSymbolLocations } from "../annotation/mapper.js";
import { checkStalenessForSymbols } from "../staleness/service.js";

// ---------------------------------------------------------------------------
// File discovery (inline — discoverFiles is not exported from deps.ts)
// ---------------------------------------------------------------------------

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

const IGNORE_DIRS = new Set([
  "node_modules", "dist", ".git", ".codegraph", "coverage",
  "__tests__", ".turbo", ".cache", "build",
]);

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
// Call graph skip set
// ---------------------------------------------------------------------------

const SKIP_CALLS = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "instanceof",
  "console", "Object", "Array", "Promise", "JSON", "Math", "parseInt", "parseFloat",
  "String", "Number", "Boolean", "Error", "fetch", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "require", "import", "super", "new", "delete",
  "void", "throw", "await", "yield", "async", "function", "class", "const", "let", "var",
  "true", "false", "null", "undefined", "NaN", "Infinity",
]);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

async function initStructuralDb(db: ReturnType<typeof createClient>): Promise<void> {
  await db.batch([
    {
      sql: `CREATE TABLE IF NOT EXISTS symbols (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        file       TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line   INTEGER NOT NULL,
        kind       TEXT NOT NULL,
        exported   INTEGER DEFAULT 0,
        service    TEXT,
        indexed_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`,
      args: [],
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS call_graph (
        id          TEXT PRIMARY KEY,
        caller      TEXT NOT NULL,
        callee      TEXT NOT NULL,
        caller_file TEXT NOT NULL,
        callee_file TEXT,
        weight      INTEGER DEFAULT 1,
        indexed_at  INTEGER NOT NULL DEFAULT (unixepoch())
      )`,
      args: [],
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS index_meta (
        repo             TEXT PRIMARY KEY,
        commit_sha       TEXT,
        indexed_at       INTEGER NOT NULL DEFAULT (unixepoch()),
        file_count       INTEGER,
        symbol_count     INTEGER,
        edge_count       INTEGER,
        previous_symbols TEXT DEFAULT '[]'
      )`,
      args: [],
    },
    { sql: `CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file)`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_call_graph_caller ON call_graph(caller)`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_call_graph_callee ON call_graph(callee)`, args: [] },
  ], "write");

  // Lazy migration: add previous_symbols to existing structural.db instances
  // that were created before this column was added (CREATE TABLE IF NOT EXISTS
  // does not alter an already-existing table).
  try {
    await db.execute(
      `ALTER TABLE index_meta ADD COLUMN previous_symbols TEXT DEFAULT '[]'`,
    );
  } catch { /* column already exists — safe to ignore */ }
}

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface IndexResult {
  repo:         string;
  commit_sha:   string;
  file_count:   number;
  symbol_count: number;
  edge_count:   number;
  skipped:      boolean;
  duration_ms:  number;
}

export interface IndexMeta {
  repo:         string;
  commit_sha:   string | null;
  indexed_at:   number;
  file_count:   number;
  symbol_count: number;
  edge_count:   number;
}

// ---------------------------------------------------------------------------
// buildIndex — concurrent write guard
// ---------------------------------------------------------------------------

// Prevents two simultaneous buildIndex calls for the same cwd from interleaving
// DELETE + INSERT and corrupting the structural.db.
const _buildLocks = new Map<string, Promise<IndexResult>>();

export function buildIndex(repo: string, cwd: string, force = false): Promise<IndexResult> {
  const inflight = _buildLocks.get(cwd);
  if (inflight) return inflight;
  const promise = _runBuildIndex(repo, cwd, force).finally(() => _buildLocks.delete(cwd));
  _buildLocks.set(cwd, promise);
  return promise;
}

async function _runBuildIndex(repo: string, cwd: string, force: boolean): Promise<IndexResult> {
  const startMs = Date.now();

  // Path traversal guard
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) {
    throw new Error(`cwd must be an absolute, non-traversal path: ${cwd}`);
  }

  // Get git commit SHA
  let commitSha = "unknown";
  try {
    commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000 })
      .toString()
      .trim();
  } catch {
    // ok — not a git repo or git not available
  }

  // Ensure .codegraph dir exists
  mkdirSync(join(cwd, ".codegraph"), { recursive: true });

  const dbPath = join(cwd, ".codegraph", "structural.db");
  const db = createClient({ url: "file:" + dbPath });

  await initStructuralDb(db);

  // Check if we can skip
  if (!force) {
    const metaRes = await db.execute({
      sql: `SELECT commit_sha, symbol_count, edge_count, file_count, indexed_at FROM index_meta WHERE repo = ?`,
      args: [repo],
    });
    if (metaRes.rows.length > 0) {
      const existing = metaRes.rows[0]!;
      if (String(existing["commit_sha"]) === commitSha) {
        return {
          repo,
          commit_sha: commitSha,
          file_count:   Number(existing["file_count"]   ?? 0),
          symbol_count: Number(existing["symbol_count"] ?? 0),
          edge_count:   Number(existing["edge_count"]   ?? 0),
          skipped:      true,
          duration_ms:  Date.now() - startMs,
        };
      }
    }
  }

  // Read previous symbol set before clearing (for deleted-symbol detection)
  let previousSymbols: string[] = [];
  try {
    const prevMeta = await db.execute({
      sql: `SELECT previous_symbols FROM index_meta WHERE repo = ?`,
      args: [repo],
    });
    if (prevMeta.rows.length > 0 && prevMeta.rows[0]!["previous_symbols"] != null) {
      previousSymbols = JSON.parse(String(prevMeta.rows[0]!["previous_symbols"])) as string[];
    }
  } catch { /* table may not have column yet */ }

  // Clear existing data
  await db.batch([
    { sql: `DELETE FROM symbols`, args: [] },
    { sql: `DELETE FROM call_graph`, args: [] },
    { sql: `DELETE FROM index_meta WHERE repo = ?`, args: [repo] },
  ], "write");

  // Discover files (discoverFiles already filters by SOURCE_EXTS)
  const allFiles = discoverFiles(cwd);
  const files = allFiles.slice(0, 500);

  // Collect symbols
  interface SymbolEntry {
    id:         string;
    name:       string;
    file:       string;
    start_line: number;
    end_line:   number;
    kind:       string;
    exported:   number;
  }

  const symbolEntries: SymbolEntry[] = [];
  const symbolsByFile = new Map<string, SymbolEntry[]>();

  for (const absPath of files) {
    const relPath = relative(cwd, absPath);
    let lines: string[] = [];
    try {
      lines = readFileSync(absPath, "utf8").split("\n");
    } catch {
      continue;
    }

    const locations = getSymbolLocations(absPath);
    const fileSymbols: SymbolEntry[] = [];

    for (const loc of locations) {
      const lineIdx = loc.start_line - 1;
      const line = lines[lineIdx] ?? "";

      // Determine kind
      let kind = "function";
      if (/class\s/.test(line)) {
        kind = "class";
      } else if (/interface\s/.test(line)) {
        kind = "interface";
      } else if (/type\s+\w+\s*=|type\s+\w+\s*\{/.test(line)) {
        kind = "type";
      } else if (/^\s{2,}[A-Za-z].*\(/.test(line)) {
        kind = "method";
      } else if (/const\s+\w+\s*=/.test(line)) {
        kind = "const";
      }

      const exported = line.includes("export") ? 1 : 0;
      const id = `${relPath}:${loc.start_line}`;

      const entry: SymbolEntry = {
        id,
        name:       loc.symbol,
        file:       relPath,
        start_line: loc.start_line,
        end_line:   loc.end_line,
        kind,
        exported,
      };
      fileSymbols.push(entry);
      symbolEntries.push(entry);
    }

    symbolsByFile.set(relPath, fileSymbols);
  }

  // Batch insert symbols
  const BATCH_SIZE = 200;
  for (let i = 0; i < symbolEntries.length; i += BATCH_SIZE) {
    const batch = symbolEntries.slice(i, i + BATCH_SIZE);
    await db.batch(
      batch.map((s) => ({
        sql: `INSERT OR REPLACE INTO symbols (id, name, file, start_line, end_line, kind, exported)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [s.id, s.name, s.file, s.start_line, s.end_line, s.kind, s.exported],
      })),
      "write",
    );
  }

  // Build call graph
  const allSymbolNames = new Set(symbolEntries.map((s) => s.name));

  // Map from symbolName -> file (first occurrence wins; used to populate callee_file)
  const symbolFileMap = new Map<string, string>();
  for (const s of symbolEntries) {
    if (!symbolFileMap.has(s.name)) symbolFileMap.set(s.name, s.file);
  }

  // weight map: "${caller}:${callee}" -> weight
  const weightMap = new Map<string, number>();
  // caller info map: "${caller}:${callee}" -> { caller_file, callee_file }
  const edgeMeta = new Map<string, { caller_file: string; callee_file: string | undefined }>();

  const CALL_RE = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

  for (const [relPath, fileSymbols] of symbolsByFile) {
    const absPath = join(cwd, relPath);
    let content: string;
    try {
      content = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");

    for (const sym of fileSymbols) {
      const bodyLines = lines.slice(sym.start_line - 1, sym.end_line);
      const bodyText = bodyLines.join("\n");

      let m: RegExpExecArray | null;
      const re = new RegExp(CALL_RE.source, "g");
      while ((m = re.exec(bodyText)) !== null) {
        const callee = m[1]!;
        if (SKIP_CALLS.has(callee)) continue;
        if (callee.length < 3) continue;
        if (callee === sym.name) continue;
        if (!allSymbolNames.has(callee)) continue;

        const key = `${sym.name}:${callee}`;
        weightMap.set(key, (weightMap.get(key) ?? 0) + 1);
        if (!edgeMeta.has(key)) {
          edgeMeta.set(key, {
            caller_file: relPath,
            callee_file: symbolFileMap.get(callee),
          });
        }
      }
    }
  }

  // Insert call graph edges
  const edgeEntries = [...weightMap.entries()].map(([key, weight]) => {
    const [caller, callee] = key.split(":") as [string, string];
    const meta = edgeMeta.get(key)!;
    return { id: key, caller, callee, caller_file: meta.caller_file, callee_file: meta.callee_file ?? null, weight };
  });

  for (let i = 0; i < edgeEntries.length; i += BATCH_SIZE) {
    const batch = edgeEntries.slice(i, i + BATCH_SIZE);
    await db.batch(
      batch.map((e) => ({
        sql: `INSERT OR REPLACE INTO call_graph (id, caller, callee, caller_file, callee_file, weight)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [e.id, e.caller, e.callee, e.caller_file, e.callee_file, e.weight],
      })),
      "write",
    );
  }

  // Current symbol names for deletion detection and next-run comparison
  const currentSymbolNames = symbolEntries.map((s) => s.name);

  // Detect deleted symbols and trigger staleness check for affected reasoning records
  if (previousSymbols.length > 0) {
    const currentSet = new Set(currentSymbolNames);
    const deletedSymbols = previousSymbols.filter((s) => !currentSet.has(s));
    if (deletedSymbols.length > 0) {
      console.log(`[claude-lore] ${deletedSymbols.length} symbols deleted — checking reasoning records`);
      checkStalenessForSymbols(repo, deletedSymbols).catch(() => {});
    }
  }

  // Upsert index_meta — store current symbols as previous_symbols for next run
  await db.execute({
    sql: `INSERT OR REPLACE INTO index_meta
            (repo, commit_sha, indexed_at, file_count, symbol_count, edge_count, previous_symbols)
          VALUES (?, ?, unixepoch(), ?, ?, ?, ?)`,
    args: [
      repo, commitSha, files.length, symbolEntries.length, edgeEntries.length,
      JSON.stringify(currentSymbolNames),
    ],
  });

  return {
    repo,
    commit_sha:   commitSha,
    file_count:   files.length,
    symbol_count: symbolEntries.length,
    edge_count:   edgeEntries.length,
    skipped:      false,
    duration_ms:  Date.now() - startMs,
  };
}

// ---------------------------------------------------------------------------
// isIndexStale
// ---------------------------------------------------------------------------

export async function isIndexStale(_repo: string, cwd: string): Promise<boolean> {
  const dbPath = join(cwd, ".codegraph", "structural.db");
  if (!existsSync(dbPath)) return true;

  let commitSha = "unknown";
  try {
    commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000 })
      .toString()
      .trim();
  } catch {}

  try {
    const db = createClient({ url: "file:" + dbPath });
    // One structural.db = one repo — take the first row regardless of name
    const res = await db.execute({
      sql: `SELECT commit_sha FROM index_meta LIMIT 1`, /* one structural.db = one repo */
      args: [],
    });
    if (res.rows.length === 0) return true;
    return String(res.rows[0]!["commit_sha"]) !== commitSha;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// getIndexStats
// ---------------------------------------------------------------------------

export async function getIndexStats(_repo: string, cwd: string): Promise<IndexMeta | null> {
  const dbPath = join(cwd, ".codegraph", "structural.db");
  if (!existsSync(dbPath)) return null;

  try {
    const db = createClient({ url: "file:" + dbPath });
    // One structural.db = one repo — take the first (and only) row regardless of name
    const res = await db.execute({
      sql: `SELECT repo, commit_sha, indexed_at, file_count, symbol_count, edge_count
            FROM index_meta LIMIT 1`, /* one structural.db = one repo */
      args: [],
    });
    if (res.rows.length === 0) return null;
    const r = res.rows[0]!;
    return {
      repo:         String(r["repo"]),
      commit_sha:   r["commit_sha"] !== null ? String(r["commit_sha"]) : null,
      indexed_at:   Number(r["indexed_at"]),
      file_count:   Number(r["file_count"]   ?? 0),
      symbol_count: Number(r["symbol_count"] ?? 0),
      edge_count:   Number(r["edge_count"]   ?? 0),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// getStructuralDb
// ---------------------------------------------------------------------------

export function getStructuralDb(cwd: string): ReturnType<typeof createClient> | null {
  const dbPath = join(cwd, ".codegraph", "structural.db");
  if (!existsSync(dbPath)) return null;
  return createClient({ url: "file:" + dbPath });
}
