---
description: Generate grounded technical documentation from the claude-lore knowledge graph. Use for /doc runbook, /doc architecture, /doc adr, /doc onboarding, /doc api commands.
argument-hint: runbook|architecture|adr|onboarding|api [scope]
allowed-tools: [Read, Glob, Grep]
---

# /doc — Generate Documentation from Knowledge Graph

Generate grounded technical documentation from the claude-lore knowledge graph.
Every section cites its graph source. Unverified content is explicitly marked `[inferred]`.

---

## Command reference

### /doc runbook [repo]

Generate an operational runbook for a service.

```
/doc runbook
/doc runbook packages/worker
```

**What it produces:**
```markdown
# Runbook: claude-lore worker

## Overview
The claude-lore worker is a background Express HTTP server on port 37778.
Managed by PM2. Handles all async processing from hook fire-and-forget POSTs.

## Pre-deploy checklist
- [ ] Run `claude-lore worker status` — confirm worker is running *(id: dec-a1b2, confidence: confirmed)*
- [ ] Run `curl http://127.0.0.1:37778/health` — confirm health endpoint responds
- [ ] Check `pm2 logs claude-lore-worker` for errors in last 100 lines

## Steps
1. Stop old worker: `pm2 stop claude-lore-worker`
2. Pull latest: `git pull`
3. Install deps: `pnpm install`
4. Start worker: `pm2 start ecosystem.config.js`
5. Verify: `curl http://127.0.0.1:37778/health`

## Known risks
- session tokens stored in ~/.codegraph/config.json — must not be committed
  *(id: risk-c3d4, confidence: extracted — session records suggest)*
- [inferred] Turso sync fails silently on existing local DBs without WAL index

## Rollback
`pm2 stop claude-lore-worker && git checkout HEAD~1 && pnpm install && pm2 start ecosystem.config.js`

## Open deferred work
- Add rate limiting to /api/sessions/observations *(id: def-e5f6, confidence: extracted)*

## [inferred] sections
The "Steps" section above is inferred from package.json and ecosystem.config.js.
Verify before use in a production incident.
```

---

### /doc architecture [scope]

Generate an architecture overview with dependency graph and ADR annotations.

```
/doc architecture
/doc architecture packages/worker
```

**What it produces:**
```markdown
# Architecture: claude-lore

## Overview
claude-lore is a monorepo with a background worker (port 37778), a CLI, hook
scripts for Claude Code and Cursor, and a Claude Code plugin. *(id: dec-a1b2)*

## Dependency graph

graph TD
  CLI["cli"] --> Worker["worker *"]
  Plugin["plugin"] --> Worker
  Hooks["hooks/claude-code"] --> Worker
  CursorHooks["hooks/cursor"] --> Worker
  Worker --> LibSQL[("libSQL\n~/.codegraph/")]
  Worker --> Anthropic["Anthropic API"]
  style Worker fill:#ffe0b2

  (* = has accepted ADR)

## Key architectural decisions
- Port 37778: avoids collision with claude-mem on 37777 *(id: dec-port, confidence: confirmed)*
- @libsql/client: single driver for local file and remote Turso *(id: dec-db, confidence: confirmed)*
- Fire-and-forget hooks: hooks never block agent operations *(id: dec-hooks, confidence: confirmed)*

## Cross-repo impact surface
[inferred] No cross-repo registry data available for this repo.

## [inferred] sections
Dependency graph is inferred from package.json files. Verify with portfolio_deps
once cross-repo indexing is configured.
```

---

### /doc adr [symbol]

Generate an ADR for a specific symbol or decision.

```
/doc adr "database driver"
/doc adr authMiddleware
/doc adr "why port 37778"
```

**What it produces:**
```markdown
# ADR: Port 37778 for the background worker

**Status:** accepted
**Date:** 2026-01-15
**Confidence:** confirmed
**Record ID:** dec-port-001

## Context
The claude-lore worker needs a fixed port. Port 3000 and 8080 are commonly used
by development servers and conflict with typical dev environments.

## Decision
Use port 37778.

## Rationale
Avoids collision with claude-mem which uses port 37777. Both tools can coexist
on the same developer machine. *(id: dec-port-001, confidence: confirmed)*

## Alternatives considered
- Port 3000: conflicts with many dev servers
- Port 8080: commonly used by proxy tools
- Dynamic port: makes hook scripts non-deterministic

## Consequences
The port is hardcoded in hook scripts and ecosystem.config.js. Change requires
updating all hook scripts and restarting the worker.
```

---

### /doc onboarding [repo]

Generate an onboarding guide for a new developer.

```
/doc onboarding
/doc onboarding packages/worker
```

**What it produces:**
```markdown
# Onboarding: claude-lore

## What is this?
claude-lore is a structural + reasoning knowledge graph for AI coding agents.
It gives agents persistent memory of a codebase — not just what the code does,
but why decisions were made, what is deferred, and what was in progress last session.

## Architecture
The system has four components: a background worker, a CLI, lifecycle hook scripts
for Claude Code and Cursor, and a Claude Code plugin.
See /doc architecture for the full dependency graph.

## Key constraints
- Never use better-sqlite3 — fails to install under Bun *(id: dec-db, confidence: confirmed)*
- Never write confidence: "confirmed" from code *(id: dec-conf, confidence: confirmed)*
- All hook scripts must exit 0 — throwing blocks Claude Code *(id: dec-hooks, confidence: confirmed)*
- personal.db must never be synced remotely *(id: dec-personal, confidence: confirmed)*

## Current state
Last session (2026-03-29): Phase 4 complete. Turso sync, auth tokens, ADR flow,
tier inference, and ecosystem config all verified.
*(session: ses-latest, confidence: extracted)*

## How to run
[inferred — verify against package.json]
1. `pnpm install`
2. `bun run packages/worker/src/index.ts`
3. `curl http://127.0.0.1:37778/health`

## Open work
- Write integration tests for MCP portfolio tools *(id: def-mcp-tests, confidence: extracted)*
- Add Turso sync support to personal.db *(id: def-personal-sync, confidence: extracted)*
```

---

### /doc api [symbol]

Generate API documentation for an exported symbol.

```
/doc api reasoning_get
/doc api authMiddleware
/doc api inferTier
```

**What it produces:**
```markdown
# API: inferTier

**File:** packages/worker/src/services/manifest/infer.ts
*(structural layer not available — inferred from source)*

## Signature
[inferred]
```typescript
function inferTier(
  symbolName: string,
  filePath: string,
  importedByRepos: string[]
): { tier: InferredTier; reason: string }
```

## Parameters
- `symbolName` — the symbol to classify
- `filePath` — source file path, used for pattern matching
- `importedByRepos` — list of other repos that import this symbol

## Returns
`{ tier, reason }` where tier is one of: redacted | public | shared | private

## Constraints
- Symbols matching `/auth|token|secret|key|password|pii|private/i` → always redacted
  *(id: dec-tiers, confidence: confirmed)*
- Pattern matching is case-insensitive *(id: dec-tiers, confidence: confirmed)*

## Known callers
inferAllTiers() in the same file. Called by GET /api/manifest/infer.
[inferred — structural layer not available for cross-repo callers]

## Related decisions
- Tier inference priority order: redacted → public → shared → private
  *(id: dec-tiers, confidence: confirmed)*
```

---

## Quality rules summary

| Rule | Behavior |
|---|---|
| Missing graph data | Write `No graph data available. Run claude-lore bootstrap to populate.` |
| Unverified section | Head the section `[inferred]` — do not mark inline |
| Citations | Every architectural claim: `*(id: {record_id}, confidence: {level})*` |
| No lore bootstrapped | Return the bootstrap prompt (see kg-doc skill) |
| Fabrication | Never — mark gaps explicitly |
