# review — Visual Codebase Review Skill

Open interactive HTML views of the codebase coloured by reasoning coverage.
Nodes and code lines are highlighted: **red** = risk, **blue** = decision,
**amber** = deferred, **grey** = no reasoning.

---

## Commands

### /review map [--layout force|radial]

Full codebase dependency map. Every file is a node; size reflects annotation
count; colour reflects the highest-priority record type attached.

Click a node to open the side panel:
- **Annotations** — full decision / risk / deferred records
- **Code** — source with lines highlighted by record type
- **Deps** — imports and dependents, clickable to navigate the graph

Filter dropdown: All files | Has reasoning | Has risks | Entry points

```
claude-lore review-map
claude-lore review-map --layout radial
claude-lore review-map --format mermaid    # Mermaid diagram to stdout
```

### /review diff [--base <ref>]

Pre-commit review overlay. Shows your current git diff with reasoning records
surfaced inline — so you can see which decisions and risks touch the lines you
are about to commit.

```
claude-lore review-diff                    # staged changes vs HEAD
claude-lore review-diff --base main        # all changes since main
claude-lore review-diff --format json      # machine-readable
```

### /review propagation <file>

Transitive impact view. Shows which files transitively import the given file —
the blast radius of any change to it. Layers are ordered by import depth so
you can see which files are directly vs indirectly affected.

```
claude-lore review-propagation src/auth/middleware.ts
claude-lore review-propagation packages/worker/src/index.ts
```

---

## When to use each view

| Situation | Command |
|---|---|
| Before a commit | `/review diff` — check reasoning against changed lines |
| Before a refactor | `/review propagation <file>` — understand blast radius |
| Onboarding to a codebase | `/review map` — visual overview of risk and decision coverage |
| Code review prioritisation | `/review map` filtered to "Has risks" |
| Architecture discussion | `/review map --layout radial` |

---

## MCP tools (for agents)

The same views are available programmatically:

```
review_map(repo, layout?, format?, open?)
review_diff(repo, base?, format?)
review_propagation(repo, file, format?)
```

Agents can call these directly without opening a browser — use `format: "json"`
for machine-readable summaries.
