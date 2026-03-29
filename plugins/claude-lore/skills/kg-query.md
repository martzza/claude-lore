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
| "what did we decide about X" | `reasoning_get(symbol=X, repo)` |
| "what breaks if I change X" | `codegraph_impact(X, repo)` → `portfolio_impact(X, repo)` |
| "what's deferred on X" | `reasoning_get(symbol=X, repo)` — filter to `deferred_work` type |
| "what was in progress last session" | `session_load(repo)` → `session_search(query, repo)` |
| "why does this code look like this" | `reasoning_get(symbol, repo)` + `codegraph_context(task, repo)` |
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
| "write me a handover / end of session summary" | `session_handover(repo)` then session-handover agent |
| "why is X written this way / why does X exist" | `provenance_trace(symbol=X, repo)` |
| "annotate this file / show me the reasoning for this code" | `annotate_file(file_path, repo)` |
| "what's the reasoning coverage for this repo" | `annotation_coverage(repo, cwd)` |
| "show me the history of X / decision history of X" | `provenance_trace(symbol=X, repo, format="mermaid")` |

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

## Strict read-only rule

**Never call `reasoning_log`, `personal_log`, or any write tool during a `/lore` query.**

Read only. Write tools are only for explicit `/lore save`, `/lore log decision`,
`/lore log risk`, or `/lore log defer` commands.

Calling a write tool in response to a query corrupts the confidence model — extracted
records must only come from the compression pass, not from answering questions.
