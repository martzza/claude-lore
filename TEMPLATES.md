# Bootstrap Template Guide

Bootstrap templates pre-populate the claude-lore reasoning layer before the first agent
session. Instead of starting cold, agents load the knowledge you care about from day one.

---

> **SECURITY:** Templates run as full Bun/Node processes with the same privileges as the
> claude-lore worker. Repo-local templates (`{repo}/.codegraph/templates/`) execute
> automatically when `claude-lore bootstrap` is run in that repo. Only run bootstrap in
> repos you trust. Review template code before running bootstrap on an unfamiliar
> codebase. Built-in templates (shipped with claude-lore) and user-local templates
> (`~/.codegraph/templates/`) are under your direct control; repo-local templates
> are not — treat them the same as any other code in a repo you clone.

---

## Install locations and resolution order

Templates are loaded from three locations. Later locations override earlier ones when
two templates share the same `id`:

| Priority | Location | Purpose |
|---|---|---|
| 1 (lowest) | `packages/worker/src/services/bootstrap/templates/` | Built-in templates shipped with claude-lore |
| 2 | `~/.codegraph/templates/` | User-local templates — your personal defaults across all repos |
| 3 (highest) | `{repo}/.codegraph/templates/` | Repo-local templates — overrides for this specific repo |

To override a built-in template, copy it to `~/.codegraph/templates/{id}/index.ts` and
modify it. The `id` field controls which template wins on collision.

---

## LoreTemplate interface

Every template is a TypeScript file with a default export implementing `LoreTemplate`:

```typescript
import type { LoreTemplate, GeneratedRecord, TemplateContext } from
  "packages/worker/src/services/bootstrap/types.js";

const template: LoreTemplate = {
  // Unique identifier, kebab-case. Used for --framework flag and collision resolution.
  id: "my-template",

  // Human-readable name shown in --list output.
  name: "My Template",

  // One-line description shown in --list output and dry-run headers.
  description: "What this template adds to the reasoning layer.",

  // Semver. Increment the minor version when adding questions;
  // increment major when changing question ids (breaking change for saved answers).
  version: "1.0.0",

  // Questions shown to the developer in the interactive wizard.
  // Answers are passed to generate().
  questions: [
    {
      id: "include_auth_risks",       // used as key in answers object
      type: "confirm",                // confirm | select | multiselect | text
      prompt: "Add auth risk records?",
      default: true,
    },
    {
      id: "framework",
      type: "select",
      prompt: "Which framework does this service use?",
      options: ["express", "fastify", "hono", "other"],
      default: "express",
    },
    {
      id: "extra_notes",
      type: "text",
      prompt: "Any additional context to pre-populate? (optional)",
      default: "",
    },
  ],

  // Called after the wizard completes. Returns records to write to the DB.
  generate(
    answers: Record<string, unknown>,
    context: TemplateContext,
  ): GeneratedRecord[] {
    const includeAuth = answers["include_auth_risks"] !== false;
    const framework = String(answers["framework"] ?? "express");

    const records: GeneratedRecord[] = [
      {
        type: "decision",
        content: `This service uses ${framework} as the HTTP framework.`,
        rationale: "Bootstrapped from my-template.",
        confidence: "inferred",    // always "inferred" — only humans confirm
        exported_tier: "private",
        anchor_status: "healthy",
      },
    ];

    if (includeAuth) {
      records.push({
        type: "risk",
        content: "All routes must enforce authorisation. Verify middleware order.",
        symbol: "auth",            // anchor to a symbol in the structural layer
        rationale: "Common auth risk for HTTP services.",
        confidence: "inferred",
        exported_tier: "private",
        anchor_status: "healthy",
      });
    }

    return records;
  },
};

export default template;
```

---

## Record types

### decision

An architectural or technical decision that should persist across sessions.

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | `"decision"` | yes | |
| `content` | `string` | yes | The decision, stated plainly |
| `rationale` | `string` | no | Why this decision was made |
| `symbol` | `string` | no | Symbol this decision is anchored to |
| `confidence` | `"inferred"` | yes | Always `"inferred"` from bootstrap |
| `exported_tier` | ExportedTier | yes | See visibility tiers below |
| `anchor_status` | `"healthy"` | yes | Always `"healthy"` from bootstrap |

### risk

A known risk, constraint, or concern that agents should be aware of.

Same fields as `decision`. The `symbol` field is especially useful here — anchoring
a risk to `auth` or `db` means agents see it when working on those symbols.

### deferred

Work explicitly parked — not forgotten, not forgotten, just not now.

Same fields as `decision`. Use the `content` field to describe what is deferred
and enough context to act on it later without re-investigation.

---

## Visibility tiers

| Tier | Stored in | Synced? | Use for |
|---|---|---|---|
| `personal` | `~/.codegraph/personal.db` | Never | Developer-only notes |
| `private` | `{repo}/.codegraph/reasoning.db` | CI reads, not out | Repo-internal constraints |
| `shared` | Global registry | Named dependencies only | Shared library interfaces |
| `public` | Global registry | All repos | Open standards, public APIs |
| `redacted` | Global registry (title only) | Existence visible | Sensitive symbols |

Templates should default to `"private"` unless the record describes something that
should be visible to other repos in a portfolio.

---

## TemplateContext

The `context` parameter in `generate()` contains:

| Field | Type | Description |
|---|---|---|
| `repo` | `string` | Absolute path of the repo being bootstrapped |
| `timestamp` | `number` | Unix ms timestamp when bootstrap started |

Use `context.repo` to build repo-relative content. For example:

```typescript
content: `Main entry point is ${context.repo}/src/index.ts`
```

---

## Auto-detecting frameworks from context

The `TemplateContext` does not currently include `dependencies` (Phase 3+). For now,
detect the framework from the repo by reading `package.json` inside `generate()`:

```typescript
import { readFileSync } from "fs";
import { join } from "path";

generate(answers, context) {
  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(context.repo, "package.json"), "utf8"));
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {}

  const usesExpress = "express" in deps;
  // ...
}
```

Phase 4+ will pass `dependencies` directly in context. Write the detection defensively
so it continues to work when the context object expands.

---

## Question types

| Type | Wizard behavior | Answer type in generate() |
|---|---|---|
| `confirm` | yes/no prompt | `boolean` |
| `select` | single-choice from `options` | `string` |
| `multiselect` | multi-choice from `options` | `string[]` |
| `text` | free-form text input | `string` |

All answers default to the `default` field value when running `--dry-run` or when
the wizard is skipped programmatically.

---

## CLI testing workflow

```bash
# Preview records without writing
claude-lore bootstrap --framework my-template --dry-run

# Apply to current repo
claude-lore bootstrap --framework my-template

# List all available templates (built-in + user-local + repo-local)
claude-lore bootstrap --list

# Verify records were written
curl -s "http://127.0.0.1:37778/api/records/pending?repo=$(pwd)" | python3 -m json.tool
```

The `--dry-run` flag prints a table of records that would be written without touching
the DB. Use it to review a template before applying it to a production repo.

---

## What makes a good built-in vs user template

**Good built-in** (submit as a PR):
- Covers a widely-used standard: OWASP, SOC 2, PCI-DSS, HIPAA, GDPR baseline
- Covers a widely-used framework: Rails, Django, Spring Boot, Next.js
- Has zero company-specific assumptions
- Generates records applicable to any repo in that category

**Better as a user-local or repo-local template**:
- Company-specific naming conventions or tech stack choices
- Internal service names, hostnames, or team-specific constraints
- Anything with proprietary information
- Experimental or highly opinionated records

---

## Submitting a built-in template

1. Fork the repo and create a branch: `git checkout -b template/my-standard`

2. Add your template at:
   `packages/worker/src/services/bootstrap/templates/{id}/index.ts`

3. Test with `--dry-run` against at least two different repos:
   ```bash
   cd repo-a && claude-lore bootstrap --framework {id} --dry-run
   cd repo-b && claude-lore bootstrap --framework {id} --dry-run
   ```

4. Verify the CI indexer still passes:
   ```bash
   CLAUDE_LORE_REPO=$(pwd) bun run packages/cli/src/ci.ts
   ```

5. Open a PR. Include in the description:
   - What standard or framework this covers
   - Example output from `--dry-run` on a real repo
   - Why this belongs as a built-in rather than a user template

Templates that generate `exported_tier: "public"` or `"shared"` records by default
receive extra scrutiny — ensure those tiers are appropriate for the records being created.
