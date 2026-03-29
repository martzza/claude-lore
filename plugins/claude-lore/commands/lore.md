---
description: Query and write to the claude-lore knowledge graph. Use for /lore questions about decisions, risks, deferred work, session history, and cross-repo dependencies.
argument-hint: <question> | help [command] | improve | workflow | parallel | skills | save <text> | log decision|risk|defer <text> | review | confirm <id> | status | bootstrap | graph | annotate <file> | provenance <symbol> | review-map | review-diff [--base <ref>] | review-propagation <file>
allowed-tools: [Read, Glob, Grep]
---

# /lore — Knowledge Graph Interface

Query and write to the claude-lore knowledge graph from within Claude Code.

---

## Command reference

### /lore help

Show the full in-chat command reference.

Calls `get_lore_help()` via MCP and returns a comprehensive reference card
covering all /lore commands with usage examples.

```
/lore help
/lore help improve
/lore help parallel
/lore help workflow
```

---

### /lore improve

Show all advisor recommendations in conversational prose.

Calls `advisor_summary(repo, cwd)` via MCP and presents findings as readable,
actionable suggestions — not CLI output, not raw JSON. Covers CLAUDE.md issues,
knowledge gaps, workflow patterns, parallelism opportunities, and skill gaps.

```
/lore improve
```

---

### /lore workflow

Show workflow patterns detected from session history and specific recommendations.

Calls `workflow_summary(repo)` and presents findings conversationally: what patterns
have been detected, why they matter, and what to change.

```
/lore workflow
```

---

### /lore parallel

Show which current deferred items can be worked on in parallel.

Calls `parallelism_check` on open deferred items and explains which tasks are safe
to run simultaneously, which have dependencies, and provides subagent prompts for
parallelisable groups.

```
/lore parallel
```

---

### /lore skills

Show the skills gap report for this repo.

Calls the skills onboarding report and explains which canonical team skills you have
installed, which are missing, and the exact commands to install them.

```
/lore skills
```

---

### /lore \<question\>

Natural language graph query. Uses the `kg-query` skill.

Dispatches to the appropriate MCP tools based on question type, then returns
a structured FACTS / ANALYSIS / GAPS response.

```
/lore what did we decide about the database driver?
/lore what breaks if I change the auth middleware?
/lore what was in progress last session?
/lore why does the hook script always exit 0?
/lore what are the cross-repo dependencies?
/lore my personal notes on the auth module
```

---

### /lore save \<text\>

Save a reasoning record. Type is auto-detected from the text:

- Text containing "decided", "chose", "using", "went with" → `decision`
- Text containing "risk", "concern", "vulnerable", "could fail" → `risk`
- Text containing "defer", "later", "TODO", "not now", "parked" → `deferred`
- Otherwise → `decision` (default)

Calls `reasoning_log(type, content, symbol?, repo)`.

```
/lore save we decided to use libsql because it supports both local and remote without migration
/lore save risk: session token storage does not meet new compliance requirements
/lore save defer: add rate limiting to /api/sessions/observations — not blocking v1
```

---

### /lore log decision \<text\>

Explicit decision record. Always writes type `decision`.

```
/lore log decision port 37778 chosen to avoid collision with claude-mem on 37777
/lore log decision @libsql/client chosen over better-sqlite3 because better-sqlite3 fails under Bun
```

---

### /lore log risk \<text\>

Explicit risk record.

```
/lore log risk personal.db must never be synced to Turso — contains developer-only notes
/lore log risk hook scripts that throw will block Claude Code operations — always exit 0
```

---

### /lore log defer \<text\>

Explicit deferred work item.

```
/lore log defer add Turso sync support to personal.db — currently local only
/lore log defer write integration tests for the MCP portfolio tools
```

---

### /lore review

Show all pending extracted records awaiting human confirmation.

Calls `GET /api/records/pending?repo={cwd}`.

Returns a table of unconfirmed records with id, type, content preview, and created_at.
Use `/lore confirm <id>` to promote a record to `confirmed`.

```
/lore review
```

---

### /lore confirm \<id\>

Confirm a pending record. Promotes confidence from `extracted` or `inferred` to `confirmed`.

Calls `POST /api/records/confirm` with `{ id, table }`.

The confirmed_by field is set from `git config user.name`.

```
/lore confirm dec-abc123
/lore confirm risk-def456
```

---

### /lore status

Show a summary of the current session context.

Calls `GET /api/context/inject?repo={cwd}&session_id={session_id}`.

Returns the context string that was injected at session start: last session summary,
open deferred items, high-confidence decisions, and active risks.

```
/lore status
```

---

### /lore bootstrap

Run the bootstrap wizard for the current repo.

Calls `POST /api/bootstrap/run` with the current repo and cwd.

Launches the interactive template wizard. Equivalent to `claude-lore bootstrap` in the
terminal, but accessible from within Claude Code without leaving the session.

```
/lore bootstrap
/lore bootstrap --framework owasp-top10
```

---

### /lore graph

Open the decision hierarchy graph in browser.

Equivalent to running `claude-lore graph decisions --open` in the terminal.

```
/lore graph
```

---

### /lore annotate \<file\>

Open a source file with reasoning annotations overlaid in browser.

Calls `annotate_file(file_path, repo)` via MCP and opens the result.

```
/lore annotate src/services/auth.ts
/lore annotate packages/worker/src/routes/sessions.ts
```

---

### /lore provenance \<symbol\>

Show the full chronological history of how a symbol came to exist.

Calls `provenance_trace(symbol, repo)` via MCP.

```
/lore provenance resolveIdentity
/lore provenance buildContextString
```

---

### /lore review-map

Open a visual codebase map showing all files and import edges, coloured by reasoning coverage.

Calls `review_map(repo, cwd)` via MCP. Node colours: red=risk, blue=decision, amber=deferred, grey=none.

Click any node to open the detail panel with three tabs:
- **Annotations** — full content of every decision, risk, and deferred record linked to this file
- **Code** — first 100 lines of source; lines matching a record symbol are highlighted in green
- **Deps** — imports and imported-by lists

```
/lore review-map
/lore review-map --layout radial
```

---

### /lore review-diff

Show the current git diff overlaid with reasoning records for each changed file.

Calls `review_diff(repo, cwd)` via MCP. Files with risks or large changes to decision-heavy code are flagged.

```
/lore review-diff
/lore review-diff --base main
```

---

### /lore review-propagation \<file\>

Show which files are transitively affected by changing a given file.

Calls `review_propagation(repo, cwd, file)` via MCP.

```
/lore review-propagation src/services/auth.ts
```

---

## Behavior rules

- `/lore <question>` is always read-only. No write tools are called.
- `/lore save`, `/lore log *` are the only commands that write to the graph.
- All written records get `confidence: "extracted"` — only humans can set `confirmed`.
- Personal records (`[personal]` tag) are never included in shared context, exports, or
  any response visible to other agents or developers.
- If the worker is not running, all commands fail with:
  `Worker not running. Start it with: claude-lore worker start`
