# audit — Knowledge Graph Audit Skill

Review gap records surfaced by `claude-lore audit`, verify claims against code,
and resolve the audit queue inline without leaving the Claude Code session.

The audit skill handles the **audit gap queue** — records with `pending_review=1`
written by the auditor. This is separate from `/lore review`, which handles
unconfirmed extracted/inferred records.

---

## Response structure

Gap queue responses use the standard FACTS / ANALYSIS / GAPS format.

Audit action responses (confirm/dismiss/defer/unknown) are conversational —
confirm the action taken, then offer the next record.

---

## Commands

### /lore audit

Show all pending gap records from the last audit run.

1. Call `GET /api/records/pending?repo={cwd}&audit_only=true`
2. If the queue is empty, say so and offer to run an estimate:
   ```
   Audit queue is empty. No gaps are pending review.
   To run a fresh audit: claude-lore audit --grep-only
   ```
3. If records exist, present them grouped by type (risks first, then decisions, then deferred)
   with full content, symbol (if set), git attribution (from rationale field), and source:

```
8 gap records pending audit review.

These were written by the auditor — they describe claims from your bootstrap
records that had no matching code evidence. Review each one:

[1] risk  (inferred)  [pending_review]
    inferred from documentation: Auth middleware validates JWT on every protected route
    source: audit:abc123
    rationale: Last code touch: David (2024-11-01) — "add auth to sessions endpoint"
    → No grep hits found for this claim

[2] decision  (inferred)  [pending_review]
    inferred from documentation: Rate limiting rejects requests over 100/min
    → LLM verdict: gap — no rate limiting implementation found in code

For each record, reply with the number and action:
  c <n>   confirm  — code supports this claim (mark as confirmed)
  d <n>   dismiss  — bootstrap was wrong, delete the original
  f <n>   defer    — convert this decision to a deferred_work item (decisions only)
  u <n>   unknown  — can't determine, clear from queue without action
  done    finish review

Or: "c all" to confirm all, "d all" to dismiss all.
```

4. Parse the user's reply and call the appropriate action (see Action routing below).
5. After each action, show a confirmation and offer the next record.

---

### /lore audit status

Show the most recent audit run for the current repo.

1. Call `GET /api/audit/status?repo={cwd}`
2. Format the result:

```
Last audit run — 2024-11-15 14:32 UTC
  Mode         grep_only
  Status       completed
  Claims found 87
  Behavioral   30
  Gaps found   5
  Records created     3
  Records deprecated  2

Run a new audit:
  claude-lore audit --estimate    (preview cost)
  claude-lore audit --grep-only   (run, no LLM)
  claude-lore audit               (run with LLM)
```

If no audit has been run: say so and suggest `claude-lore audit --estimate`.

---

### /lore audit estimate

Tell the developer how to get a cost estimate. Do NOT shell out — direct them
to the CLI:

```
Run this in your terminal to get an estimate:
  claude-lore audit --estimate

The estimate shows: file count, records to audit, behavioral vs structural
breakdown, expected LLM calls, and estimated cost (usually < $0.10).
No worker calls — it's instant.
```

---

## Action routing

When the user responds to the gap review with numbered actions, call the
appropriate worker endpoint for each:

| User input | Action | API call |
|---|---|---|
| `c <n>` | confirm — code backs the claim | `POST /api/records/confirm { id, table, action: "confirm" }` |
| `d <n>` | dismiss — original was wrong | `POST /api/records/confirm { id, table, action: "dismiss" }` |
| `f <n>` | defer — convert to deferred_work | `POST /api/records/confirm { id, table: "decisions", action: "defer" }` |
| `u <n>` | unknown — clear without action | `POST /api/records/confirm { id, table, action: "unknown" }` |

After each action, show:
- `c` → "✓ confirmed — record is now trusted by the agent"
- `d` → "✗ dismissed — record and its bootstrap source deprecated"
- `f` → "→ deferred — created as open deferred_work item"
- `u` → "? unknown — cleared from queue, no change to record"

---

## Rules

- `/lore audit` is read-only except for review actions (confirm/dismiss/defer/unknown).
- Never call `reasoning_log` during audit review — use only `reasoning_confirm` and
  the confirm endpoint with action parameter.
- Only `decisions` records can use `action: "defer"` — if the user tries to defer a
  risk or deferred_work record, explain the restriction and offer confirm/dismiss/unknown.
- Display the `rationale` field (which may contain git attribution) so the developer
  can see who last touched the related code.
- If the gap has `llmReasoning` in its content, surface it prominently — it explains
  why the LLM classified it as a gap.
- Never confirm a gap record just because the claim sounds plausible — instruct the
  developer to check the code themselves if uncertain. Suggest using `unknown` if
  they cannot verify right now.

---

## Relationship to /lore review

| Command | Queue | Records |
|---|---|---|
| `/lore review` | Unconfirmed records | `confidence IN ('extracted', 'inferred')` |
| `/lore audit` | Audit gap queue | `pending_review = 1` (set by auditor) |

A record can be in both queues simultaneously (if it is both inferred AND flagged
by the auditor). In that case, resolving it via `/lore audit` clears it from both.
