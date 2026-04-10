import { existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, isAbsolute, resolve, relative, extname } from "path";
import { createClient } from "@libsql/client";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { parseFile } from "./parser.js";
import { hashFile } from "./hasher.js";
import { checkStalenessForSymbols } from "../staleness/service.js";
import { detectCommunities } from "./communities.js";

// ---------------------------------------------------------------------------
// File discovery
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
        is_test    INTEGER DEFAULT 0,
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
        call_line   INTEGER,
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
    {
      sql: `CREATE TABLE IF NOT EXISTS file_hashes (
        file_path  TEXT PRIMARY KEY,
        sha256     TEXT NOT NULL,
        indexed_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`,
      args: [],
    },
    { sql: `CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file)`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_call_graph_caller ON call_graph(caller)`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_call_graph_callee ON call_graph(callee)`, args: [] },
    {
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_call_graph_unique
            ON call_graph(caller, callee, caller_file)`,
      args: [],
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS communities (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        symbols     TEXT NOT NULL,
        files       TEXT NOT NULL,
        size        INTEGER NOT NULL,
        hub_symbol  TEXT,
        description TEXT,
        detected_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`,
      args: [],
    },
  ], "write");

  // Lazy migrations for structural.db instances created before these columns
  const migrations = [
    `ALTER TABLE index_meta ADD COLUMN previous_symbols TEXT DEFAULT '[]'`,
    `ALTER TABLE symbols ADD COLUMN is_test INTEGER DEFAULT 0`,
    `ALTER TABLE call_graph ADD COLUMN call_line INTEGER`,
    `ALTER TABLE call_graph ADD COLUMN kind TEXT DEFAULT 'calls'`,
    `ALTER TABLE symbols ADD COLUMN community TEXT`,
  ];
  for (const sql of migrations) {
    try { await db.execute(sql); } catch { /* column already exists */ }
  }

  // Rebuild unique index to include kind (Phase C prerequisite).
  // The old index was (caller, callee, caller_file); the new one adds kind so
  // 'calls' and 'test_covers' edges for the same pair can coexist.
  try { await db.execute(`DROP INDEX IF EXISTS idx_call_graph_unique`); } catch {}
  try {
    await db.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_call_graph_unique
       ON call_graph(caller, callee, caller_file, kind)`,
    );
  } catch {}
}

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface IndexResult {
  repo:            string;
  commit_sha:      string;
  file_count:      number;
  symbol_count:    number;
  edge_count:      number;
  skipped:         boolean;
  duration_ms:     number;
  incremental?:    boolean;
  changed_files?:  number;
  unchanged_files?: number;
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

const _buildLocks = new Map<string, Promise<IndexResult>>();

export function buildIndex(repo: string, cwd: string, force = false): Promise<IndexResult> {
  const inflight = _buildLocks.get(cwd);
  if (inflight) return inflight;
  const promise = _runBuildIndex(repo, cwd, force).finally(() => _buildLocks.delete(cwd));
  _buildLocks.set(cwd, promise);
  return promise;
}

async function loadFileHashes(db: ReturnType<typeof createClient>): Promise<Map<string, string>> {
  const rows = await db.execute("SELECT file_path, sha256 FROM file_hashes");
  return new Map(rows.rows.map((r) => [String(r["file_path"]), String(r["sha256"])]));
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

  // Check if we can skip (commit SHA unchanged AND not force)
  if (!force) {
    const metaRes = await db.execute({
      sql:  `SELECT commit_sha, symbol_count, edge_count, file_count, indexed_at FROM index_meta WHERE repo = ?`,
      args: [repo],
    });
    if (metaRes.rows.length > 0) {
      const existing = metaRes.rows[0]!;
      if (String(existing["commit_sha"]) === commitSha) {
        return {
          repo,
          commit_sha:   commitSha,
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
      sql:  `SELECT previous_symbols FROM index_meta WHERE repo = ?`,
      args: [repo],
    });
    if (prevMeta.rows.length > 0 && prevMeta.rows[0]!["previous_symbols"] != null) {
      previousSymbols = JSON.parse(String(prevMeta.rows[0]!["previous_symbols"])) as string[];
    }
  } catch { /* table may not have column yet */ }

  // Discover all source files
  const allFiles = discoverFiles(cwd).slice(0, 500);

  // Load existing file hashes for incremental detection
  const existingHashes = await loadFileHashes(db);
  const newHashes      = new Map<string, string>();
  const changedFiles:   string[] = [];
  const unchangedFiles: string[] = [];

  for (const f of allFiles) {
    const relPath = relative(cwd, f);
    const hash = hashFile(f);
    if (!hash) continue;
    newHashes.set(relPath, hash);
    if (!force && existingHashes.get(relPath) === hash) {
      unchangedFiles.push(f);
    } else {
      changedFiles.push(f);
    }
  }

  const isIncremental = !force && unchangedFiles.length > 0 && changedFiles.length < allFiles.length;
  const filesToParse  = isIncremental ? changedFiles : allFiles;

  if (filesToParse.length === 0 && isIncremental) {
    // All files unchanged — update commit SHA and return
    await db.execute({
      sql:  `UPDATE index_meta SET commit_sha = ?, indexed_at = unixepoch() WHERE repo = ?`,
      args: [commitSha, repo],
    });
    const existing = await db.execute({
      sql:  `SELECT symbol_count, edge_count, file_count FROM index_meta WHERE repo = ?`,
      args: [repo],
    });
    const row = existing.rows[0];
    return {
      repo, commit_sha: commitSha,
      file_count:     allFiles.length,
      symbol_count:   Number(row?.["symbol_count"] ?? 0),
      edge_count:     Number(row?.["edge_count"]   ?? 0),
      skipped:        false,
      duration_ms:    Date.now() - startMs,
      incremental:    true,
      changed_files:  0,
      unchanged_files: unchangedFiles.length,
    };
  }

  console.log(
    `[claude-lore] indexing ${filesToParse.length} files` +
    (isIncremental ? ` (${unchangedFiles.length} unchanged, skipped)` : ""),
  );

  if (isIncremental) {
    // Delete only changed-file symbols/edges so unchanged data stays intact
    for (const f of changedFiles) {
      const relPath = relative(cwd, f);
      await db.execute({ sql: `DELETE FROM symbols WHERE file = ?`,           args: [relPath] });
      await db.execute({ sql: `DELETE FROM call_graph WHERE caller_file = ?`, args: [relPath] });
    }
  } else {
    // Full rebuild — clear everything
    await db.batch([
      { sql: `DELETE FROM symbols`,    args: [] },
      { sql: `DELETE FROM call_graph`, args: [] },
      { sql: `DELETE FROM file_hashes`, args: [] },
    ], "write");
  }

  // Build symbol file map for callee_file resolution (load existing for incremental)
  const symbolFileMap = new Map<string, string>();
  if (isIncremental) {
    const existing = await db.execute(`SELECT name, file FROM symbols`);
    for (const r of existing.rows) {
      const name = String(r["name"]);
      if (!symbolFileMap.has(name)) symbolFileMap.set(name, String(r["file"]));
    }
  }

  let symbolCount = 0;
  let edgeCount   = 0;

  // Parse each file
  for (const filePath of filesToParse) {
    const relPath = relative(cwd, filePath);
    const parsed  = await parseFile(filePath);
    if (!parsed) continue;

    const BATCH_SIZE = 200;

    // Write symbols
    for (let i = 0; i < parsed.symbols.length; i += BATCH_SIZE) {
      const batch = parsed.symbols.slice(i, i + BATCH_SIZE);
      await db.batch(
        batch.map((sym) => ({
          sql:  `INSERT OR REPLACE INTO symbols
                 (id, name, file, start_line, end_line, kind, exported, is_test)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            randomUUID(), sym.name, relPath,
            sym.start_line, sym.end_line,
            sym.kind,
            sym.exported ? 1 : 0,
            sym.is_test  ? 1 : 0,
          ],
        })),
        "write",
      );
      symbolCount += batch.length;

      // Update symbolFileMap
      for (const sym of batch) {
        if (!symbolFileMap.has(sym.name)) symbolFileMap.set(sym.name, relPath);
      }
    }

    // Deduplicate call edges within this file (weight = occurrence count)
    // Key includes kind so 'calls' and 'test_covers' edges for the same pair coexist
    const edgeWeight = new Map<string, { call_line: number; weight: number; callee_file?: string; kind: string }>();
    for (const call of parsed.calls) {
      const key = `${call.caller}:${call.callee}:${call.kind}`;
      const existing = edgeWeight.get(key);
      if (existing) {
        existing.weight++;
      } else {
        edgeWeight.set(key, {
          call_line:   call.call_line,
          weight:      1,
          callee_file: symbolFileMap.get(call.callee),
          kind:        call.kind,
        });
      }
    }

    // Write call edges
    const edges = [...edgeWeight.entries()];
    for (let i = 0; i < edges.length; i += BATCH_SIZE) {
      const batch = edges.slice(i, i + BATCH_SIZE);
      await db.batch(
        batch.map(([key, meta]) => {
          const parts = key.split(":");
          const kind   = parts.pop()!;
          const callee = parts.pop()!;
          const caller = parts.join(":");   // handles any colons in caller name
          return {
            sql:  `INSERT INTO call_graph (id, caller, callee, caller_file, callee_file, call_line, weight, kind)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(caller, callee, caller_file, kind) DO UPDATE SET weight = weight + excluded.weight`,
            args: [
              randomUUID(), caller, callee, relPath,
              meta.callee_file ?? null,
              meta.call_line,
              meta.weight,
              meta.kind,
            ],
          };
        }),
        "write",
      );
      edgeCount += batch.length;
    }

    // Update file hash
    const hash = newHashes.get(relPath);
    if (hash) {
      await db.execute({
        sql:  `INSERT OR REPLACE INTO file_hashes (file_path, sha256) VALUES (?, ?)`,
        args: [relPath, hash],
      });
    }
  }

  // For non-incremental, count all symbols/edges (some came from previous data)
  if (!isIncremental) {
    const sc = await db.execute(`SELECT COUNT(*) as n FROM symbols`);
    const ec = await db.execute(`SELECT COUNT(*) as n FROM call_graph`);
    symbolCount = Number(sc.rows[0]?.["n"] ?? symbolCount);
    edgeCount   = Number(ec.rows[0]?.["n"] ?? edgeCount);
  } else {
    // For incremental, add to existing counts
    const sc = await db.execute(`SELECT COUNT(*) as n FROM symbols`);
    const ec = await db.execute(`SELECT COUNT(*) as n FROM call_graph`);
    symbolCount = Number(sc.rows[0]?.["n"] ?? symbolCount);
    edgeCount   = Number(ec.rows[0]?.["n"] ?? edgeCount);
  }

  // Detect communities after full rebuild or when enough files changed
  if (!isIncremental || changedFiles.length > 10) {
    console.log("[claude-lore] detecting communities...");
    try {
      const communities = await detectCommunities(db);

      await db.execute("DELETE FROM communities");
      for (const c of communities) {
        await db.execute({
          sql:  `INSERT INTO communities (id, name, symbols, files, size, hub_symbol, description)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [c.id, c.name, JSON.stringify(c.symbols), JSON.stringify(c.files),
                 c.size, c.hub_symbol ?? null, c.description],
        });
        // Tag each symbol with its community (batch for performance)
        for (let i = 0; i < c.symbols.length; i += 200) {
          const batch = c.symbols.slice(i, i + 200);
          await db.batch(
            batch.map((sym) => ({
              sql:  "UPDATE symbols SET community = ? WHERE name = ?",
              args: [c.name, sym],
            })),
            "write",
          );
        }
      }
      console.log(`[claude-lore] found ${communities.length} communities`);
    } catch (e) {
      console.warn("[claude-lore] community detection failed:", e);
    }
  }

  // Current symbol names for deletion detection
  const currentRes = await db.execute(`SELECT name FROM symbols`);
  const currentSymbolNames = currentRes.rows.map((r) => String(r["name"]));

  // Detect deleted symbols and trigger staleness check
  if (previousSymbols.length > 0) {
    const currentSet = new Set(currentSymbolNames);
    const deletedSymbols = previousSymbols.filter((s) => !currentSet.has(s));
    if (deletedSymbols.length > 0) {
      console.log(`[claude-lore] ${deletedSymbols.length} symbols deleted — checking reasoning records`);
      checkStalenessForSymbols(repo, deletedSymbols).catch(() => {});
    }
  }

  // Upsert index_meta
  await db.execute({
    sql:  `INSERT OR REPLACE INTO index_meta
           (repo, commit_sha, indexed_at, file_count, symbol_count, edge_count, previous_symbols)
           VALUES (?, ?, unixepoch(), ?, ?, ?, ?)`,
    args: [
      repo, commitSha, allFiles.length,
      symbolCount, edgeCount,
      JSON.stringify(currentSymbolNames),
    ],
  });

  return {
    repo,
    commit_sha:      commitSha,
    file_count:      allFiles.length,
    symbol_count:    symbolCount,
    edge_count:      edgeCount,
    skipped:         false,
    duration_ms:     Date.now() - startMs,
    incremental:     isIncremental,
    changed_files:   filesToParse.length,
    unchanged_files: unchangedFiles.length,
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
    const res = await db.execute({
      sql:  `SELECT commit_sha FROM index_meta LIMIT 1`,
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
    const res = await db.execute({
      sql:  `SELECT repo, commit_sha, indexed_at, file_count, symbol_count, edge_count
             FROM index_meta LIMIT 1`,
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
