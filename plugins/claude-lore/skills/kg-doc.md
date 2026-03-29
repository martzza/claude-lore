# kg-doc — Knowledge Graph Documentation Skill

Generate documentation from the claude-lore knowledge graph. Every document is
grounded in graph records — no fabrication, no hallucination. Unverified sections
are explicitly marked `[inferred]`.

---

## Document types and tool sequences

### /doc runbook [repo]

Operational runbook for a service or workflow.

**Tool call sequence:**
1. `session_load(repo)` — current state + open deferred items
2. `reasoning_get(repo=repo)` filtered to `risks` — known risks
3. `reasoning_get(repo=repo)` filtered to `deferred_work` — open items

**Output sections:**
```
## Overview
Brief description of what this service does and its operational boundaries.

## Pre-deploy checklist
- [ ] Items derived from risk records and deferred_work with deploy relevance

## Steps
Step-by-step operational procedure, grounded in session history.

## Known risks
Drawn from risk records. Each risk cites its record id and confidence level.
[inferred] risks are clearly marked.

## Rollback
Rollback procedure. If no graph data exists, marked "No rollback procedure documented."

## Open deferred work
Items from deferred_work records that are unresolved. Each cites its record id.

## [inferred] sections
Any section derived without graph data is headed [inferred] and must be
verified before use in a production incident.
```

---

### /doc architecture [scope]

Architecture overview with dependency graph and ADR annotations.

**Tool call sequence:**
1. `portfolio_deps(repo)` — full dependency graph for this repo
2. `portfolio_impact(symbol, repo)` on key exported symbols — cross-repo effects
3. `reasoning_get(repo=repo)` filtered to accepted decisions — ADR annotations

**Output sections:**
```
## Architecture overview
Prose description of the system architecture.

## Dependency graph
Mermaid flowchart of repos and their dependencies.
Nodes with accepted ADRs are flagged with *.
Nodes with high or critical risk records are highlighted in red.

graph TD
  A[repo-a] --> B[repo-b *]
  A --> C[repo-c]
  style B fill:#ffe0b2

## Key architectural decisions
Each accepted decision record cited by id and confidence.

## Cross-repo impact surface
Symbols that, if changed, affect other repos. Derived from portfolio_impact.

## [inferred] sections
Any section without graph backing is marked [inferred].
```

---

### /doc adr [symbol]

Architecture Decision Record for a specific symbol or decision.

**Tool call sequence:**
1. `reasoning_get(symbol=symbol)` filtered to `adr_candidates` and decisions
2. `codegraph_context(symbol, repo)` if structural layer is available

**Output format:**
```markdown
# ADR: {title}

**Status:** draft | accepted | superseded
**Date:** YYYY-MM-DD
**Confidence:** confirmed | extracted | inferred
**Record ID:** {id}

## Context
Why this decision was needed. Drawn from graph record `context` field.
If not in graph: [inferred] — verify against codebase.

## Decision
What was decided. Direct quote from graph record where available.

## Rationale
Why this option was chosen. From graph record `rationale` field.

## Alternatives considered
What was rejected and why. From graph record `alternatives` field.
If no alternatives documented: "No alternatives recorded. Consider adding via /lore log decision."

## Consequences
What this means going forward. Agent inference over the decision + impact data.
Clearly labelled as [inferred] unless sourced from a confirmed record.
```

---

### /doc onboarding [repo]

Onboarding guide for a new developer joining a repo.

**Tool call sequence:**
1. `portfolio_deps(repo)` — what this repo depends on
2. `session_load(repo)` — current state and recent session context
3. `reasoning_get(repo=repo)` filtered to `accepted` decisions — key constraints
4. `reasoning_get(repo=repo)` filtered to open `deferred_work` — what's in flight

**Output sections:**
```
## What is this?
One-paragraph description of what this repo does and who uses it.

## Architecture
How this repo fits into the broader system. Uses portfolio_deps data.
References architecture ADRs by id.

## Key constraints
The confirmed and extracted decisions that all contributors must know.
Each constraint cites its record id and confidence.

## Current state
Drawn from session_load. What was in progress as of the last session.
Marked with session date.

## How to run
[inferred] unless a decision record documents this. If inferred, marked clearly
and points to package.json / README for authoritative steps.

## Open work
Open deferred_work items. Each cites its record id, confidence, and created_at date.
```

---

### /doc api [symbol]

API reference for a specific exported symbol.

**Tool call sequence:**
1. `codegraph_context(symbol, repo)` — structural signature and callers
2. `reasoning_get(symbol=symbol)` — decisions and risks on this interface

**Output sections:**
```
## {symbol}

**File:** {file_path from structural layer, or [structural layer not available]}

### Signature
From structural layer if available. Otherwise [inferred from source — verify].

### Parameters
Each parameter with type and description. Structural layer preferred.
If no structural data: [inferred].

### Returns
Return type and semantics. Structural layer preferred.

### Constraints
Risk records and decision records attached to this symbol. Each cites record id.

### Known callers
From codegraph_context callers list. Cross-repo callers from portfolio_impact.

### Related decisions
Decision records on this symbol, confidence-prefixed.
```

---

### /doc annotate [file_path]

Prose explanation of the reasoning behind a source file's code.
Not the code itself — the story of the code.

**Tool call sequence:**
1. `annotate_file(file_path, repo, format="json")` — get all annotations
2. For each annotated symbol with decisions or risks, call `provenance_trace(symbol, repo)` to get timeline

**Output sections:**
```
## Reasoning behind {file_name}

### {symbol_name}
{symbol} was shaped by the following decisions and constraints:

**Decision:** {decision content} *(id: {record_id}, confidence: {level})*
**Rationale:** {rationale if present}
**Risk:** {risk content} *(id: {record_id})*
**Deferred:** {deferred content} — {N} days open

**Provenance:** {2-sentence summary from provenance_trace}

[Repeat for each annotated symbol]

## Unannotated symbols
The following symbols in this file have no reasoning records:
{list of unannotated symbol names}
Run `claude-lore bootstrap` or use `/lore log decision` to add records.
```

**Rules:**
- Only include symbols that have at least one reasoning record
- Cite every claim with its record id
- Mark inferred provenance summaries as [inferred]
- If no annotations exist for the file: "No reasoning records found. Run claude-lore bootstrap."

---

## Advisor-augmented generation

Before generating any document type, optionally call `advisor_summary(repo, cwd)` to surface
gaps that the document should acknowledge. If the advisor returns priority gaps, add an
**Advisor notes** section at the end of the generated document:

```
## Advisor notes
The following knowledge gaps may affect the accuracy of this document:
- [gap_type] {description} (score: {score})
Run `claude-lore advisor gaps` for the full gap report.
```

This section is always labelled `[advisor]` so readers know it comes from the gap advisor,
not from confirmed records.

---

## Document quality rules

1. **Every architectural claim cites a graph record.** Format: `*(id: {record_id}, confidence: {level})*`

2. **Sections inferred without graph data are marked `[inferred]`.** The `[inferred]` marker
   appears in the section heading, not inline, so readers can skip or verify the whole section.

3. **Never fabricate content.** If a section has no graph data and cannot be inferred from
   the repo structure, write: `No graph data available. Run claude-lore bootstrap to populate.`

4. **If /doc is run on a repo with no lore:**
   ```
   No reasoning records found for this repo.

   To bootstrap:
     claude-lore init          # add claude-lore to this repo
     claude-lore bootstrap     # interactive wizard to pre-populate records

   For security defaults:
     claude-lore bootstrap --framework owasp-top10

   Once bootstrapped, /doc commands will return structured documentation.
   ```

5. **Confidence cascade:** If the highest-confidence record for a key claim is `extracted`,
   the generated document section is marked `[unreviewed — session records only]`. Use
   `claude-lore review` to promote to `confirmed` before treating as authoritative.
