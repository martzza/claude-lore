# claude-lore

Structural + reasoning knowledge graph for AI coding agents. Gives AI agents
persistent memory of a codebase — not just what the code does (structural layer),
but why decisions were made, what is deferred, what risks exist, and what was
in progress last session (reasoning layer).

Distributed as a Claude Code plugin. Works with Claude Code and Cursor via MCP
and lifecycle hooks. Open source.

---

## What problem this solves

AI coding agents start every session cold. They re-explore decisions already made,
propose changes that violate constraints established last week, and have no awareness
of how a change in one repo breaks another. claude-lore fixes this by maintaining
a queryable knowledge graph that agents load at session start.

---

## Architecture overview

### Two layers

**Structural layer** — what the code does
- Symbol graph, call graph, blast radius (adapted from CodeGraph)
- Indexed per repo, versioned by commit SHA

**Reasoning layer** — why the code is the way it is
- ADRs, decisions, deferred work, risks, session state
- Symbol-anchored: records link to real symbols in the structural layer
- Confidence-scored: `confirmed | extracted | inferred | contested`
- Visibility-tiered: `personal | private | shared | public | redacted`

### Visibility tiers

| Tier | Where stored | Synced? |
|---|---|---|
| `personal` | `~/.codegraph/personal.db` | Never — developer-only |
| `private` | `{repo}/.codegraph/reasoning.db` | CI reads, not synced out |
| `shared` | Global registry | Named dependencies only |
| `public` | Global registry | All repos in portfolio |
| `redacted` | Global registry (title only) | Existence visible, detail private |

### Confidence levels

| Level | Source | How agent presents it |
|---|---|---|
| `confirmed` | Human-reviewed | Stated as fact with citation |
| `extracted` | AI compression, unreviewed | "session records suggest..." |
| `inferred` | Bootstrap importer | "inferred from documentation..." |
| `contested` | Conflicting records | Surfaces conflict, picks no winner |

---

## Monorepo structure

```
claude-lore/
  packages/
    worker/          # Background HTTP worker (port 37778)
    hooks/
      claude-code/   # Hook scripts for Claude Code
      cursor/        # Hook scripts for Cursor
    cli/             # claude-lore CLI
  plugins/
    claude-lore/     # Claude Code plugin (skills, hooks, commands)
  templates/         # Config templates for target repos
```

### Global files (per developer machine)

```
~/.codegraph/
  sessions.db      # Session store (libSQL local)
  personal.db      # Personal tier records — never synced
  registry.db      # Cross-repo registry (Phase 3+)
  config.json      # Turso URLs + auth tokens (Phase 4+)
```

### Per-repo files (added by claude-lore init)

```
{repo}/
  .codegraph/
    reasoning.db     # Reasoning store (libSQL local)
    exports.manifest # What this repo publishes to the registry
    config.json      # Visibility defaults, canonical skills
    templates/       # Repo-local bootstrap templates
  .claude/
    settings.json    # Claude Code hook registration
  .cursor/
    hooks.json       # Cursor hook registration
    mcp.json         # MCP server config
```

---

## Worker

Runs on `http://127.0.0.1:37778` (37778 avoids collision with claude-mem on 37777).

Managed by PM2 — starts on machine boot, restarts on crash.

### Endpoints

| Method | Path | Called by |
|---|---|---|
| POST | `/api/sessions/init` | SessionStart hook |
| POST | `/api/sessions/observations` | PostToolUse hook |
| POST | `/api/sessions/summarise` | Stop hook |
| POST | `/api/sessions/complete` | SessionEnd hook |
| GET | `/api/context/inject` | SessionStart hook (returns context string) |
| GET | `/health` | Health check |

All hook scripts POST and exit immediately — fire and forget.
The worker handles all async processing. Hooks always exit 0.

---

## Database

### Driver: @libsql/client

Local file mode for Phase 1-3. No Turso account needed.
Phase 4 team mode: add `syncUrl` + `authToken` to the same client — no migration.

```typescript
import { createClient } from "@libsql/client";

const db = createClient({ url: "file:/Users/you/.codegraph/sessions.db" });

// All queries are async
const result = await db.execute({ sql: "SELECT * FROM sessions WHERE id = ?", args: [id] });
result.rows // array of row objects
```

Key API notes:
- `db.execute({ sql, args })` — async, returns `{ rows }`
- `db.batch([statements], "write")` — atomic multi-statement DDL
- No `.prepare()` — inline queries only
- `args` uses positional `?` placeholders

### Main tables (sessions.db)

- `sessions` — one row per agent session
- `decisions` — architectural decisions with rationale
- `deferred_work` — items explicitly parked
- `risks` — documented risks and constraints
- `skill_manifest` — skill file hashes for consistency checking

### Personal table (personal.db)

- `personal_records` — developer-only notes, never synced

All records have: `id TEXT PK`, `repo TEXT`, `confidence TEXT`, `exported_tier TEXT`,
`anchor_status TEXT` (healthy | re-anchored | orphaned), `created_at INTEGER`.

---

## Hook integration

### Claude Code hooks

Registered in `.claude/settings.json` or via the plugin's `hooks/hooks.json`.

```
SessionStart    → context-hook.js    (injects prior context as system message)
UserPromptSubmit → intent-hook.js   (detects decision/risk/deferral keywords)
PostToolUse     → observe-hook.js   (Write|Edit|Bash — logs observations)
Stop            → summary-hook.js   (triggers AI compression pass)
SessionEnd      → cleanup-hook.js   (marks session complete)
```

### Cursor hooks

Registered in `.cursor/hooks.json`. Uses `conversation_id` instead of `session_id`.
Context hook uses a lockfile (`/tmp/claude-lore-{id}.lock`) to inject once per conversation.

```
beforeSubmitPrompt  → cursor/context-hook.js
afterFileEdit       → cursor/observe-hook.js
beforeShellExecution → cursor/shell-hook.js
stop                → cursor/summary-hook.js (also cleans up lockfile)
```

### Hook script pattern

Every hook script follows this exact pattern:

```javascript
#!/usr/bin/env node
import { readFileSync } from "fs";

const PORT = process.env.CLAUDE_LORE_PORT ?? "37778";

async function main() {
  let input = {};
  try { input = JSON.parse(readFileSync("/dev/stdin", "utf8")); } catch {}

  // ... do work, POST to worker ...
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/...`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ... }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {} // always silent on error
}

main().catch(() => {}).finally(() => process.exit(0)); // always exit 0
```

---

## AI compression pass

Fires at the `Stop` hook. Calls `claude-sonnet-4-20250514` via `@anthropic-ai/sdk`.

Extracts from raw observations into structured JSON:
- `summary` — 2-3 sentence session summary
- `symbols_touched` — symbol names referenced
- `decisions` — architectural decisions made
- `deferred` — work explicitly parked
- `risks` — risks identified
- `adr_candidates` — decisions worth formal ADR review

All extracted records get `confidence: "extracted"`. Only humans set `confirmed`.

---

## Bootstrap template system

Templates pre-populate the reasoning layer before the first session.

### Resolution order (later overrides earlier on `id` collision)
1. Built-in: `packages/worker/src/services/bootstrap/templates/`
2. User: `~/.codegraph/templates/`
3. Repo-local: `{repo}/.codegraph/templates/`

### Template interface (simplified)

```typescript
interface LoreTemplate {
  id:          string;       // kebab-case, unique
  name:        string;
  description: string;
  version:     string;
  questions:   Question[];   // confirm | select | multiselect | text
  generate(answers: Record<string, unknown>, context: TemplateContext): GeneratedRecord[];
}
```

### Built-in templates
- `sample` — reference implementation, annotated, copy to make your own
- `owasp-top10` — OWASP Top 10 (2021), risk records anchored to file patterns

### CLI usage
```bash
claude-lore bootstrap                          # interactive wizard
claude-lore bootstrap --framework owasp-top10  # specific template
claude-lore bootstrap --dry-run                # preview without writing
claude-lore bootstrap --list                   # list available templates
```

---

## MCP tools (Phase 2+)

Exposed via `@modelcontextprotocol/sdk`. Same tools available to Claude Code and Cursor.

### Structural
- `codegraph_context(task, repo?)` — primary entry point
- `codegraph_search(query, repo?)` — symbol search
- `codegraph_callers(symbol, repo?)` — all callers
- `codegraph_impact(symbol, repo?)` — blast radius

### Reasoning
- `reasoning_get(symbol?, repo?)` — decisions + deferred + risks for a symbol
- `reasoning_log(type, content, symbol?)` — write a reasoning record
- `session_load(repo)` — last summary + open deferred items
- `session_search(query, repo?)` — search session history

### Personal
- `personal_log(type, content, symbol?, repo?)` — write personal record
- `personal_get(symbol?, repo?)` — retrieve personal records

### Cross-repo (Phase 3+)
- `portfolio_context(task)` — cross-repo codegraph_context
- `portfolio_impact(symbol, repo)` — cross-repo blast radius
- `portfolio_deps(repo)` — full dependency graph

---

## Claude Code plugin

Registered via `.claude-plugin/marketplace.json` (marketplace) and
`plugins/claude-lore/.claude-plugin/plugin.json` (plugin manifest).

### Skills
- `kg-query` — graph query skill (FACTS / ANALYSIS / GAPS structure)
- `kg-doc` — document generation skill (/doc runbook, /doc architecture, /doc adr, /doc onboarding)

### Commands
- `/lore <question>` — natural language graph query
- `/doc <type> <scope>` — generate documentation from graph

---

## CLI commands

```bash
claude-lore init                    # initialise repo
claude-lore bootstrap               # run bootstrap wizard
claude-lore bootstrap --security    # security wizard (OWASP, SOC2, etc.)
claude-lore index                   # index structural layer (Phase 3+)
claude-lore skills                  # show skill manifest
claude-lore skills --diff           # show skill drift across repos
claude-lore review                  # review pending extracted records
claude-lore worker start            # start worker via PM2
claude-lore worker stop
claude-lore worker status
```

---

## Tech stack

| Concern | Choice |
|---|---|
| Runtime | Bun |
| Language | TypeScript strict |
| Package manager | pnpm (workspaces) |
| Worker framework | Express |
| Worker port | 37778 |
| Database driver | `@libsql/client` (local file → Turso remote) |
| Process management | PM2 |
| MCP | `@modelcontextprotocol/sdk` |
| AI compression | `@anthropic-ai/sdk`, claude-sonnet-4-20250514 |
| Node minimum | 24 |
| CLI binary | compiled with `bun build --compile`, symlinked to `~/.bun/bin/claude-lore` |
| Rebuild CLI | `pnpm run build:cli` from repo root |

---

## Build phases

| Phase | Deliverables |
|---|---|
| 1 | Worker · CC + Cursor hooks · libSQL schema · context injection · bootstrap templates · personal layer · CLI stub |
| 2 | Full MCP server · reasoning tools · confidence scoring · confirmation loop · security bootstrap wizard |
| 3 | exports.manifest · global registry · cross-repo MCP tools · staleness detector · skills consistency checker |
| 4 | Turso remote sync · CI indexer · per-dev auth · PR-native ADR flow · coverage report |
| 5 | Query + generation skills · /doc commands · README · OSS prep |

---

## Coding conventions

### Never do these
- Never use `better-sqlite3` — fails to install under Bun
- Never use synchronous DB calls — `@libsql/client` is async throughout
- Never write `confidence: "confirmed"` from code — only humans confirm
- Never sync `personal.db` to any remote store
- Never throw from a hook script — always exit 0
- Never block a hook on worker availability — POST and exit regardless

### Always do these
- All hook scripts exit 0 via `.finally(() => process.exit(0))`
- All DB queries: `await db.execute({ sql: "...", args: [...] })`
- All DDL: `await db.batch([...statements], "write")`
- Row access: `result.rows[0]`, `result.rows.length === 0` for empty check
- `INSERT OR IGNORE` for idempotent writes (hook retries are expected)
- Type all DB columns as `unknown` then cast — libsql rows are untyped

### TypeScript
- Strict mode always
- Zod for API boundary validation
- No `any` in service layer — use `unknown` and narrow explicitly

### File naming
- Hook scripts: `{event}-hook.js` (plain JS, no build step needed)
- MCP tools: `snake_case` matching the spec names
- DB tables: `snake_case`, plural
- CLI commands: `kebab-case`

---

## Key decisions

**Port 37778** — avoids collision with claude-mem which uses 37777. Both can coexist.

**@libsql/client** — single driver for local file and remote Turso. Phase 4 is a
`syncUrl` + `authToken` config addition, not a migration.

**Fire-and-forget hooks** — hooks POST to worker and exit immediately. Worker queues
async work. This ensures hooks never block Claude Code operations.

**No ORM** — direct SQL via `db.execute()`. Schema is small, queries are known,
ORM overhead not justified.

**Separate personal.db** — enforced by file location outside any repo. CI cannot
reach `~/.codegraph/personal.db`. No access control layer needed.

**Confidence extracted for all auto-capture** — the compression pass never writes
`confirmed`. Human review via `claude-lore review` is the only path to confirmed.

**Plain JS hook scripts** — hook scripts are `.js` not `.ts`. No build step means
hooks work immediately after `bun install` with no compilation.
