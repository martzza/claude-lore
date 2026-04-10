# kg-query — Knowledge Graph Query Skill

Query the claude-lore knowledge graph for decisions, deferred work, risks, and session
history. Always returns a structured three-section response.

---

## Response structure (mandatory — every response must use this exact format)

```
FACTS [source: {record_id}, confidence: {level}]
- Only what the graph returned — no extrapolation
- confirmed records: stated as fact with citation
- extracted records: prefixed "session records suggest:"
- inferred records: prefixed "inferred from documentation:"
- contested records: "conflicting records exist for this symbol:"
- personal records: marked [personal] — never referenced outside this session

ANALYSIS
- Agent reasoning over the retrieved facts
- Clearly labelled as inference, never presented as fact
- Conflicts between records are called out explicitly
- Stale records (old created_at) are flagged

GAPS
- What could not be determined from the graph
- Never omit this section even if it is empty
- Gaps drive completeness — they tell the developer what to capture next
```

The GAPS section is required in every response. An empty GAPS section is written as:
```
GAPS
- None identified from available graph data.
```

---

## Question routing table

Map the user's question to the correct MCP tool sequence before answering:

| Question type | Tool sequence |
|---|---|
| "help me work on a task / give me context for X" | `get_minimal_context(task, repo)` — primary entry point; returns compact context under 300 tokens |
| "what did we decide about X" | `reasoning_get(symbol=X, repo)` |
| "what breaks if I change X" | `codegraph_impact(X, repo)` then `portfolio_impact(X, repo)` for cross-repo |
| "who calls X / what uses X" | `codegraph_callers(symbol, repo)` |
| "what does X call / what does X depend on" | `codegraph_callees(symbol, repo)` |
| "find symbol / search for X" | `codegraph_search(query, repo)` |
| "context for task / help me work on X" | `get_minimal_context(task, repo)` first; fall back to `codegraph_context(task, repo)` for full context |
| "what's deferred on X" | `reasoning_get(symbol=X, repo)` — filter to `deferred_work` type |
| "what was in progress last session" | `session_load(repo)` → `session_search(query, repo)` |
| "why does this code look like this" | `reasoning_get(symbol, repo)` + `session_load(repo)` |
| "what are the cross-repo dependencies" | `portfolio_deps(repo)` → `portfolio_context(task)` |
| "my personal notes on X" | `personal_get(symbol=X, repo)` |
| general symbol question | `reasoning_get(symbol, repo)` + `session_load(repo)` |
| time-based or narrative | `session_load(repo)` + `session_search(query, repo)` |
| "what are the gaps / what should we document next" | `advisor_summary(repo, cwd)` |
| "how is our CLAUDE.md / any CLAUDE.md issues" | `advisor_summary(repo, cwd)` |
| "what skills should we create" | `advisor_summary(repo, cwd)` |
| "can I run these tasks in parallel" | `parallelism_check(tasks, repo)` |
| "which tasks are safe to parallelise" | `parallelism_check(tasks, repo)` |
| "what's my workflow like / how am I working" | `workflow_summary(repo)` |
| "what should I work on next" | `workflow_summary(repo)` + `session_handover(repo)` + deferred items from `session_load` |
| "/lore help" or "/lore" with no arguments | `get_lore_help()` — return full reference card as formatted text |
| "/lore help <command>" | `get_lore_help(command)` — return detailed help for that command |
| "/lore improve / how can I improve / what should I change" | `advisor_summary(repo, cwd)` — present findings in conversational prose, not CLI format |
| "/lore workflow" | `workflow_summary(repo)` — explain patterns and recommendations conversationally |
| "/lore parallel" | `parallelism_check` on open deferred items — explain which tasks can run in parallel and why |
| "/lore skills" | `annotation_coverage(repo, cwd)` then skills onboarding report — explain gaps conversationally |
| "should I update CLAUDE.md / is my CLAUDE.md good" | `advisor_summary(repo, cwd)` → filter to claudemd findings |
| "write me a handover / end of session summary" | `session_handover(repo)` then session-handover agent |
| "why is X written this way / why does X exist" | `provenance_trace(symbol=X, repo)` |
| "annotate this file / show me the reasoning for this code" | `annotate_file(file_path, repo)` |
| "what's the reasoning coverage for this repo" | `annotation_coverage(repo, cwd)` |
| "show me the history of X / decision history of X" | `provenance_trace(symbol=X, repo, format="mermaid")` |
| "/lore review-map" or "show me the codebase map" | `review_map(repo, cwd)` — opens visual file dependency map |
| "/lore review-diff" or "review my changes / pre-commit review" | `review_diff(repo, cwd)` — shows git diff with reasoning overlay |
| "/lore review-propagation <file>" or "what breaks if I change X file" | `review_propagation(repo, cwd, file=X)` — blast radius for a file change |
| "/lore review" or "review pending records" | `reasoning_pending(repo)` — interactive confirm/discard loop (see Review flow section) |
| "/lore audit" or "review audit gaps" | `GET /api/records/pending?audit_only=true` — audit gap queue review (see audit skill) |
| "/lore audit status" | `GET /api/audit/status?repo={cwd}` — last audit run stats |
| "/lore audit estimate" | Direct to CLI: `claude-lore audit --estimate` — no API call needed |
| "/lore compress" or "compress session / run compression" | `compress_session(repo)` → extract → `submit_compression(session_id, repo, extraction)` |

**If structural index not built** (`codegraph_*` returns `error: structural index not built`):
→ Fall back to `portfolio_impact` for blast radius
→ Tell the user: "Run `claude-lore index` to enable symbol-level queries"

When in doubt, start with `reasoning_get` + `session_load` and extend based on what gaps
appear in the initial results. For broad health or completeness questions, prefer
`advisor_summary` as an efficient single call that surfaces gaps, CLAUDE.md findings,
skill suggestions, parallelism opportunities, and workflow patterns together.

---

## Confidence display rules

The MCP tools return records with confidence prefixes already applied. Reproduce them
exactly — do not strip, rephrase, or promote the confidence level:

- `confirmed` — no prefix, cited as fact: `Port 37778 was chosen to avoid collision with claude-mem. *(id: dec-abc123)*`
- `extracted` — keep prefix: `session records suggest: auth middleware was added to all routes *(id: dec-def456)*`
- `inferred` — keep prefix: `inferred from documentation: the service uses JWT for session tokens *(id: risk-ghi789)*`
- `contested` — surface the conflict: `conflicting records exist for this symbol: one record says X, another says Y`
- `personal` — marked `[personal]` and never included in shared context or logs

---

## Step-by-step execution

1. Parse the question for symbol names, repo context, and question type.
2. Look up the routing table above and call the indicated tool(s).
3. Collect all returned records.
4. Build the FACTS section from tool results only — nothing else.
5. Write ANALYSIS as explicit inference over the facts.
6. Write GAPS listing anything the graph did not cover.
7. Output the three sections in order.

---

## Advisor commands — conversational format

When handling `/lore improve`, `/lore workflow`, `/lore parallel`, or `/lore skills`,
**do not** use the FACTS / ANALYSIS / GAPS format. Instead, respond in natural
conversational prose with specific, actionable suggestions:

- Lead with the most important finding
- Use plain language, not CLI output style
- Include exact commands the developer should run
- Group related findings under short headings if there are many
- End with one clear "highest priority action" recommendation

Example of good advisor output:
```
Your CLAUDE.md is 6,200 tokens — that's a significant chunk of context on every session.
The biggest win would be moving the API reference tables to a separate file and linking
to it. That alone would save ~2,000 tokens per session.

You also have 3 deferred items that can run in parallel today:
• "Add validation to auth endpoints" — no symbol overlap with others
• "Update telemetry schema" — independent module
These are safe to tackle simultaneously with subagents.

Highest priority: run `claude-lore advisor claudemd --apply` to trim the CLAUDE.md bloat.
```

## Review flow — `/lore review`

`/lore review` is the one exception to the read-only rule. It runs an interactive
confirm/discard loop entirely inside the Claude Code session.

### How to handle `/lore review`

1. Call `reasoning_pending(repo)` to fetch all unconfirmed records.
2. If the list is empty, say so and stop.
3. If there are records, present the first batch (up to 10) as a numbered list:

```
12 records pending review.

[1] decision  (extracted)  — session records suggest: switched to tRPC for end-to-end type safety
[2] risk      (inferred)   — A03 Injection: SQL queries in src/db/queries.ts are not parameterised  [db]
[3] deferred  (extracted)  — Add rate limiting to all public endpoints
...

For each: reply with the numbers to confirm (e.g. "c 1 3 5"), discard (e.g. "d 2"), or skip ("s").
Type "c all" to confirm all, "d all" to discard all, or "done" to finish.
```

4. Parse the user's reply:
   - `c <numbers>` or `c all` → call `reasoning_confirm(id, table)` for each
   - `d <numbers>` or `d all` → call `reasoning_discard(id, table)` for each
   - `s` or no input → skip, move to next batch
   - `done` or `q` → stop
5. After each batch, show counts (`X confirmed, Y discarded`) and offer the next batch.
6. When all records are processed, print a final summary.

### Rules for the review flow

- Present records grouped by type: risks first (highest stakes), then decisions, then deferred.
- Show the full content for each record, not truncated.
- If a record's symbol is set, show it in brackets: `[authMiddleware]`.
- `reasoning_confirm` and `reasoning_discard` are the **only** write tools permitted during `/lore review`.
- Never call `reasoning_log` during review — this loop is for reviewing existing records, not creating new ones.
- After confirming a record, do not re-display it as pending.

---

## Strict read-only rule

**Never call `reasoning_log`, `personal_log`, or any write tool during a `/lore` query.**

Read only. Write tools are only for explicit `/lore save`, `/lore log decision`,
`/lore log risk`, or `/lore log defer` commands.

Calling a write tool in response to a query corrupts the confidence model — extracted
records must only come from the compression pass, not from answering questions.
