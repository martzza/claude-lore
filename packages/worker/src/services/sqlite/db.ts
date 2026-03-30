import { createClient, type Client, type Config } from "@libsql/client";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CODEGRAPH_DIR = join(homedir(), ".codegraph");

export let sessionsDb: Client;
export let personalDb: Client;
export let registryDb: Client;

// Module-level Turso state — read by health endpoint
let tursoSyncUrl: string | null = null;

export function getTursoStatus(): { connected: boolean; syncUrl: string | null } {
  return { connected: !!tursoSyncUrl, syncUrl: tursoSyncUrl };
}

export function hasTurso(): boolean {
  return !!tursoSyncUrl;
}

export async function syncNow(): Promise<void> {
  if (!tursoSyncUrl) return;
  try {
    await sessionsDb.sync();
    await registryDb.sync();
  } catch (err) {
    console.error("[turso] sync error:", err);
  }
}

export async function initDb(): Promise<void> {
  mkdirSync(CODEGRAPH_DIR, { recursive: true });

  const tursoUrl = process.env["CLAUDE_LORE_TURSO_URL"];
  const tursoToken = process.env["CLAUDE_LORE_TURSO_AUTH_TOKEN"];
  const hasTurso = !!(tursoUrl && tursoToken);
  if (hasTurso) tursoSyncUrl = tursoUrl!;

  // personalDb intentionally never gets syncUrl — personal tier is local-only
  personalDb = createClient({ url: `file:${join(CODEGRAPH_DIR, "personal.db")}` });

  if (hasTurso) {
    // Turso requires DBs be opened fresh with syncUrl — existing local-only DBs
    // will fail ("no wal_index"). Fall back gracefully so dev mode is unaffected.
    try {
      sessionsDb = createClient({
        url: `file:${join(CODEGRAPH_DIR, "sessions.db")}`,
        syncUrl: tursoUrl!,
        authToken: tursoToken!,
      } as Config);
      registryDb = createClient({
        url: `file:${join(CODEGRAPH_DIR, "registry.db")}`,
        syncUrl: tursoUrl!,
        authToken: tursoToken!,
      } as Config);
    } catch (err) {
      console.warn("[turso] Could not open DBs with syncUrl, falling back to local-only:", err);
      tursoSyncUrl = null;
      sessionsDb = createClient({ url: `file:${join(CODEGRAPH_DIR, "sessions.db")}` });
      registryDb = createClient({ url: `file:${join(CODEGRAPH_DIR, "registry.db")}` });
    }
  } else {
    sessionsDb = createClient({ url: `file:${join(CODEGRAPH_DIR, "sessions.db")}` });
    registryDb = createClient({ url: `file:${join(CODEGRAPH_DIR, "registry.db")}` });
  }

  await initSessionsSchema();
  await initPersonalSchema();
  await initRegistrySchema();
  await runMigrations();

  if (tursoSyncUrl) {
    await syncNow();
  }
}

async function initSessionsSchema(): Promise<void> {
  await sessionsDb.batch(
    [
      {
        sql: `CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          repo TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          summary TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL
        )`,
        args: [],
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS decisions (
          id TEXT PRIMARY KEY,
          repo TEXT NOT NULL,
          session_id TEXT,
          symbol TEXT,
          content TEXT NOT NULL,
          rationale TEXT,
          confidence TEXT NOT NULL DEFAULT 'extracted',
          exported_tier TEXT NOT NULL DEFAULT 'private',
          anchor_status TEXT NOT NULL DEFAULT 'healthy',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(id)
        )`,
        args: [],
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS deferred_work (
          id TEXT PRIMARY KEY,
          repo TEXT NOT NULL,
          session_id TEXT,
          symbol TEXT,
          content TEXT NOT NULL,
          confidence TEXT NOT NULL DEFAULT 'extracted',
          exported_tier TEXT NOT NULL DEFAULT 'private',
          anchor_status TEXT NOT NULL DEFAULT 'healthy',
          status TEXT NOT NULL DEFAULT 'open',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(id)
        )`,
        args: [],
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS risks (
          id TEXT PRIMARY KEY,
          repo TEXT NOT NULL,
          session_id TEXT,
          symbol TEXT,
          content TEXT NOT NULL,
          confidence TEXT NOT NULL DEFAULT 'extracted',
          exported_tier TEXT NOT NULL DEFAULT 'private',
          anchor_status TEXT NOT NULL DEFAULT 'healthy',
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(id)
        )`,
        args: [],
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS observations (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          repo TEXT NOT NULL,
          tool_name TEXT,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(id)
        )`,
        args: [],
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS skill_manifest (
          id TEXT PRIMARY KEY,
          repo TEXT NOT NULL,
          skill_name TEXT NOT NULL,
          file_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`,
        args: [],
      },
    ],
    "write",
  );
}

async function initRegistrySchema(): Promise<void> {
  await registryDb.batch(
    [
      {
        sql: `CREATE TABLE IF NOT EXISTS repo_manifests (
          repo TEXT PRIMARY KEY,
          manifest TEXT NOT NULL,
          synced_at INTEGER NOT NULL
        )`,
        args: [],
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS cross_repo_index (
          symbol TEXT NOT NULL,
          repo TEXT NOT NULL,
          tier TEXT NOT NULL,
          signature TEXT,
          indexed_at INTEGER NOT NULL,
          PRIMARY KEY (symbol, repo)
        )`,
        args: [],
      },
    ],
    "write",
  );
}

async function runMigrations(): Promise<void> {
  // Phase 2: confirmed_by on all mutable record tables
  const reasoningTables = ["decisions", "deferred_work", "risks"];
  for (const table of reasoningTables) {
    try {
      await sessionsDb.execute(`ALTER TABLE ${table} ADD COLUMN confirmed_by TEXT`);
    } catch {} // column already exists — expected on subsequent starts
  }
  try {
    await personalDb.execute(`ALTER TABLE personal_records ADD COLUMN confirmed_by TEXT`);
  } catch {}

  // Phase 3: anchor tracking columns
  const reasoningTables3 = ["decisions", "deferred_work", "risks"];
  for (const table of reasoningTables3) {
    try {
      await sessionsDb.execute(`ALTER TABLE ${table} ADD COLUMN original_symbol TEXT`);
    } catch {}
  }
  // blocked_by on deferred_work for coverage report
  try {
    await sessionsDb.execute(`ALTER TABLE deferred_work ADD COLUMN blocked_by TEXT`);
  } catch {}
  // scope on skill_manifest
  try {
    await sessionsDb.execute(`ALTER TABLE skill_manifest ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'`);
  } catch {}
  try {
    await sessionsDb.execute(`ALTER TABLE skill_manifest ADD COLUMN updated_at INTEGER`);
  } catch {}

  // Phase 4: ADR columns on decisions
  const adrCols = [
    `ALTER TABLE decisions ADD COLUMN adr_status TEXT`,       // draft | accepted | superseded
    `ALTER TABLE decisions ADD COLUMN adr_title TEXT`,
    `ALTER TABLE decisions ADD COLUMN adr_context TEXT`,
    `ALTER TABLE decisions ADD COLUMN adr_alternatives TEXT`,
  ];
  for (const sql of adrCols) {
    try { await sessionsDb.execute(sql); } catch {}
  }

  // Phase 5: source column for bootstrap provenance (template:<id>)
  const sourceTables = ["decisions", "deferred_work", "risks"];
  for (const table of sourceTables) {
    try {
      await sessionsDb.execute(`ALTER TABLE ${table} ADD COLUMN source TEXT`);
    } catch {} // column already exists — expected on subsequent starts
  }

  // Phase 5: fingerprint column for importer deduplication
  for (const table of sourceTables) {
    try {
      await sessionsDb.execute(`ALTER TABLE ${table} ADD COLUMN fingerprint TEXT`);
    } catch {}
  }

  // Portfolio linking: portfolio column on registry tables
  try {
    await registryDb.execute(
      `ALTER TABLE repo_manifests ADD COLUMN portfolio TEXT NOT NULL DEFAULT 'default'`,
    );
  } catch {}
  try {
    await registryDb.execute(
      `ALTER TABLE cross_repo_index ADD COLUMN portfolio TEXT NOT NULL DEFAULT 'default'`,
    );
  } catch {}

  // Phase 7: per-developer attribution + sync infrastructure
  const attributionTables = ["decisions", "deferred_work", "risks"];
  for (const table of attributionTables) {
    try {
      await sessionsDb.execute(`ALTER TABLE ${table} ADD COLUMN created_by TEXT`);
    } catch {} // column already exists
  }

  // sync_log — one row per sync attempt
  try {
    await sessionsDb.execute(`
      CREATE TABLE IF NOT EXISTS sync_log (
        id TEXT PRIMARY KEY,
        synced_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        sessions_changed INTEGER NOT NULL DEFAULT 0,
        registry_changed INTEGER NOT NULL DEFAULT 0,
        error TEXT
      )
    `);
  } catch {}

  // sync_conflicts — records where remote overwrote a local confirmed record
  // or a remote confirmation appeared for a record we hadn't seen
  try {
    await sessionsDb.execute(`
      CREATE TABLE IF NOT EXISTS sync_conflicts (
        id TEXT PRIMARY KEY,
        detected_at INTEGER NOT NULL,
        repo TEXT NOT NULL,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        conflict_type TEXT NOT NULL,
        local_content TEXT,
        remote_content TEXT,
        local_confirmed_by TEXT,
        remote_confirmed_by TEXT,
        resolved INTEGER NOT NULL DEFAULT 0
      )
    `);
  } catch {}

  // Phase 6: per-service scoping for monorepo support
  // Nullable — existing rows get service = NULL meaning "whole repo"
  const serviceTables = ["decisions", "deferred_work", "risks", "observations", "sessions"];
  for (const table of serviceTables) {
    try {
      await sessionsDb.execute(`ALTER TABLE ${table} ADD COLUMN service TEXT`);
    } catch {} // column already exists — expected on subsequent starts
  }
  // Composite indexes for efficient service-scoped queries
  const serviceIndexes: Array<[string, string, string]> = [
    ["idx_decisions_repo_service",   "decisions",    "(repo, service)"],
    ["idx_deferred_repo_service",    "deferred_work","(repo, service)"],
    ["idx_risks_repo_service",       "risks",        "(repo, service)"],
    ["idx_observations_session_svc", "observations", "(session_id, service)"],
    ["idx_sessions_repo_service",    "sessions",     "(repo, service)"],
  ];
  for (const [name, table, cols] of serviceIndexes) {
    try {
      await sessionsDb.execute(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} ${cols}`);
    } catch {}
  }
}

async function initPersonalSchema(): Promise<void> {
  await personalDb.batch(
    [
      {
        sql: `CREATE TABLE IF NOT EXISTS personal_records (
          id TEXT PRIMARY KEY,
          repo TEXT NOT NULL,
          type TEXT NOT NULL,
          symbol TEXT,
          content TEXT NOT NULL,
          confidence TEXT NOT NULL DEFAULT 'extracted',
          exported_tier TEXT NOT NULL DEFAULT 'personal',
          anchor_status TEXT NOT NULL DEFAULT 'healthy',
          created_at INTEGER NOT NULL
        )`,
        args: [],
      },
    ],
    "write",
  );
}
