# Changelog

## [1.0.0] — 2026-04-02

Structural layer complete. All codegraph_* MCP tools now live.

### Added
- Structural layer indexer: symbol extraction + call graph from TS/JS source
- 5 new MCP tools: codegraph_search, codegraph_callers, codegraph_callees,
  codegraph_impact, codegraph_context
- `claude-lore index` CLI command with progress output and SHA-based skip
- HTTP endpoints: POST /api/structural/index, GET /api/structural/stats,
  GET /api/structural/stale, GET /api/structural/search, GET /api/structural/callers,
  GET /api/structural/callees, GET /api/structural/impact
- Doctor now checks structural index status (STRUCTURAL section)
- Graph symbol view enriched with call graph nodes when structural.db exists
- /health endpoint includes structural.indexed status

### Changed
- kg-query.md routing table: codegraph_* tools now live, Phase 3+ annotations removed
- Version bumped from 0.9.0 to 1.0.0

---

## [0.9.0] — 2026-03-29

Feature-complete reasoning layer. Production-hardened with security audit,
comprehensive doctor checks, and team sync.

### Added
- Full reasoning layer: decisions, risks, deferred work, session compression,
  confidence scoring
- 26 MCP tools for Claude Code and Cursor
- 40+ CLI commands
- Bootstrap template system (OWASP Top 10, security checklist,
  monorepo-services, cursor-rules)
- MD file importer — discovers ADRs, CLAUDE.md, git history
- Portfolio system for multi-repo cross-repo awareness
- Turso team sync with conflict detection and per-developer auth
- Advisor suite: knowledge gaps, CLAUDE.md optimisation, skill gaps,
  parallelism analysis, workflow pattern detection
- 4 specialist agents: blast-radius-checker, adr-drafter, session-handover,
  cross-repo-validator, code-reviewer
- Visual graph layer: decision hierarchy, symbol impact, portfolio dependency
  map (Mermaid, DOT, D3 interactive)
- Code annotation: annotated source view, provenance trace, annotation coverage
- Visual code review: codebase map, decision propagation, pre-commit diff overlay
- Comprehensive doctor with 15+ checks, --fix, --watch, --json
- Full help system: CLI grouped reference + /lore help in chat
- Monorepo service scoping on all MCP tools and DB queries
- Cursor rules importer
- Personal notes layer (never synced, never shared)
- Solo/team mode with interactive setup wizard
- CLAUDE.md interactive wizard

### Security
- Full security audit completed
- Command injection fix (execFileSync replacing execSync)
- Path traversal protection on all cwd-accepting endpoints
- Cursor lockfile path sanitisation
- config.json written with 0o600 permissions
- Compression deduplication guard
- Observation cap (500 per session, ring buffer eviction)
- Template directory scan cap (100 entries)
- Personal DB boundary verified — never synced under any condition

### Known gaps (targeting 1.0.0)
- Structural layer (Phase 3): codegraph_* MCP tools not yet built;
  blast radius queries use portfolio registry only

---

## [0.5.0] — internal milestone

MCP server, reasoning tools, confidence scoring, bootstrap system,
cross-repo registry, staleness detector, skills checker.

---

## [0.1.0] — initial release

Worker, Claude Code + Cursor hooks, libSQL schema, context injection,
personal layer, CLI stub.
