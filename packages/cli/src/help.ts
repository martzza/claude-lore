// ---------------------------------------------------------------------------
// claude-lore CLI help system
// Full CommandHelp and LoreCommandHelp entries for every command
// ---------------------------------------------------------------------------

export type HelpGroup =
  | "getting-started"
  | "reviewing"
  | "querying"
  | "visualising"
  | "portfolio"
  | "adr"
  | "skills"
  | "system"
  | "importing";

export interface FlagHelp {
  flag:   string;
  short?: string;
  desc:   string;
}

export interface ExampleHelp {
  command: string;
  desc:    string;
}

export interface CommandHelp {
  name:        string;
  summary:     string;
  description: string;
  usage:       string[];
  flags:       FlagHelp[];
  examples:    ExampleHelp[];
  seeAlso:     string[];
  group:       HelpGroup;
}

export interface LoreCommandHelp {
  command:   string;
  summary:   string;
  detail:    string;
  example?:  string;
  mcp_tools: string[];
}

// ---------------------------------------------------------------------------
// CLI commands
// ---------------------------------------------------------------------------

export const CLI_COMMANDS: CommandHelp[] = [
  {
    name: "bootstrap",
    group: "getting-started",
    summary: "Pre-populate the knowledge graph from existing docs and templates.",
    description:
      "Scans all .md files, ADRs, and git history in this repo for architectural decisions, risks, and deferred items. Optionally applies security and compliance templates. On first run, shows a full explanation of what claude-lore does and what each step accomplishes.",
    usage: [
      "claude-lore bootstrap                    Interactive (recommended first-run)",
      "claude-lore bootstrap --framework <id>   Apply one specific template",
      "claude-lore bootstrap --all --yes        Apply all templates, skip prompts",
      "claude-lore bootstrap --dry-run          Preview without writing",
      "claude-lore bootstrap --list             Show available templates",
    ],
    flags: [
      { flag: "--framework <id>", desc: "Run a specific template only (e.g. owasp-top10)" },
      { flag: "--all",            desc: "Apply all non-hidden templates" },
      { flag: "--yes", short: "-y", desc: "Skip confirmation prompts" },
      { flag: "--dry-run",        desc: "Preview records without writing" },
      { flag: "--list",           desc: "List available templates and exit" },
    ],
    examples: [
      { command: "claude-lore bootstrap",
        desc: "Interactive first-run experience with full explanation and step-by-step progress" },
      { command: "claude-lore bootstrap --framework owasp-top10",
        desc: "Apply OWASP Top 10 risks only, with preview and confirmation" },
      { command: "claude-lore bootstrap --all --yes --dry-run",
        desc: "Preview everything that would be written, write nothing" },
    ],
    seeAlso: ["import", "review", "advisor"],
  },

  {
    name: "index",
    group: "getting-started",
    summary: "Build the structural index — symbols and call graph for this repo.",
    description:
      "Scans all TypeScript and JavaScript files, extracts symbol definitions and call relationships, and writes them to .codegraph/structural.db. Required for codegraph_* MCP tools (codegraph_search, codegraph_callers, codegraph_impact, codegraph_context). Re-run after significant code changes; skips automatically if the git commit SHA is unchanged.",
    usage: [
      "claude-lore index              Build or update the structural index",
      "claude-lore index --force      Force full rebuild (ignores commit SHA)",
      "claude-lore index --service <n>  Scope to one service in a monorepo",
    ],
    flags: [
      { flag: "--force",          desc: "Rebuild even if commit SHA is unchanged" },
      { flag: "--service <name>", desc: "Scope to a monorepo service" },
    ],
    examples: [
      { command: "claude-lore index",        desc: "First-time index — run after init" },
      { command: "claude-lore index --force", desc: "Full rebuild after major refactor" },
    ],
    seeAlso: ["init", "doctor", "graph"],
  },

  {
    name: "init",
    group: "getting-started",
    summary: "Initialise a repo for claude-lore.",
    description:
      "Creates the .codegraph/ directory and config, registers Claude Code and Cursor hooks in .claude/settings.json and .cursor/hooks.json, and starts the background worker. Run once per repo before using any other commands.",
    usage: [
      "claude-lore init",
      "claude-lore init --repo <path>",
    ],
    flags: [
      { flag: "--repo <path>", desc: "Path to the repo root (defaults to cwd)" },
    ],
    examples: [
      { command: "claude-lore init",           desc: "Initialise the current directory" },
      { command: "claude-lore init --repo ~/projects/my-service", desc: "Initialise a specific repo" },
    ],
    seeAlso: ["bootstrap", "doctor"],
  },

  {
    name: "help",
    group: "getting-started",
    summary: "Show command reference.",
    description:
      "Without arguments, shows the grouped command reference. With a command name, shows full detail including usage, flags, and examples for that command.",
    usage: [
      "claude-lore help",
      "claude-lore help <command>",
    ],
    flags: [],
    examples: [
      { command: "claude-lore help",            desc: "Full grouped command reference" },
      { command: "claude-lore help bootstrap",  desc: "Detailed help for the bootstrap command" },
      { command: "claude-lore help portfolio",  desc: "Detailed help for portfolio subcommands" },
    ],
    seeAlso: ["doctor", "status"],
  },

  {
    name: "status",
    group: "reviewing",
    summary: "Current repo state at a glance.",
    description:
      "Shows a summary of the current repo: worker health, last session, record counts, pending reviews, advisor findings, and open deferred items. Designed to be the first command you run when returning to a repo.",
    usage: [
      "claude-lore status",
      "claude-lore status --json",
    ],
    flags: [
      { flag: "--json", desc: "Output as JSON (no decorative formatting)" },
    ],
    examples: [
      { command: "claude-lore status",       desc: "Human-readable repo state" },
      { command: "claude-lore status --json | jq .records", desc: "Pipe record counts to jq" },
    ],
    seeAlso: ["review", "doctor", "advisor"],
  },

  {
    name: "doctor",
    group: "getting-started",
    summary: "Verify everything is wired up correctly.",
    description:
      "Checks the worker, hooks, CLI binary, databases, and portfolio configuration. Reports passed checks, warnings (like a stale binary), and errors (like missing hooks). With --fix, applies automatic corrections where safe.",
    usage: [
      "claude-lore doctor",
      "claude-lore doctor --fix",
      "claude-lore doctor --json",
    ],
    flags: [
      { flag: "--fix",  desc: "Apply automatic fixes where safe (missing hooks, stale binary)" },
      { flag: "--json", desc: "Output results as JSON" },
    ],
    examples: [
      { command: "claude-lore doctor",       desc: "Full system check with human-readable report" },
      { command: "claude-lore doctor --fix", desc: "Fix missing hooks and rebuild stale binary" },
    ],
    seeAlso: ["update", "init", "status"],
  },

  {
    name: "update",
    group: "system",
    summary: "Rebuild CLI and restart worker.",
    description:
      "Rebuilds the CLI binary from source, relinks it to ~/.bun/bin/claude-lore, restarts the background worker, and confirms the system is healthy. Run after pulling new changes.",
    usage: [
      "claude-lore update",
    ],
    flags: [],
    examples: [
      { command: "claude-lore update", desc: "Rebuild CLI and restart worker" },
    ],
    seeAlso: ["doctor", "worker start"],
  },

  {
    name: "review",
    group: "reviewing",
    summary: "List unconfirmed records — confirm or discard.",
    description:
      "Shows all records with confidence 'extracted' or 'inferred' — those captured automatically by the compression pass or bootstrap, awaiting human review. Walk through them and confirm the important ones. Confirmed records carry more weight with your agent.",
    usage: [
      "claude-lore review",
      "claude-lore review --json",
    ],
    flags: [
      { flag: "--json", desc: "Output records as JSON array" },
    ],
    examples: [
      { command: "claude-lore review", desc: "Interactive review flow" },
    ],
    seeAlso: ["advisor", "status"],
  },

  {
    name: "advisor",
    group: "reviewing",
    summary: "Workflow and gap suggestions.",
    description:
      "Runs all four advisor analyses (knowledge gaps, CLAUDE.md quality, skill gaps, parallelism, workflow) and returns consolidated findings. Run regularly to keep the knowledge graph healthy and your CLAUDE.md lean.",
    usage: [
      "claude-lore advisor",
      "claude-lore advisor --json",
    ],
    flags: [
      { flag: "--json", desc: "Output as JSON" },
    ],
    examples: [
      { command: "claude-lore advisor",         desc: "All advisor findings" },
    ],
    seeAlso: ["advisor gaps", "advisor claudemd", "advisor workflow", "advisor parallel"],
  },

  {
    name: "advisor gaps",
    group: "reviewing",
    summary: "Knowledge gaps needing attention.",
    description:
      "Finds symbols touched frequently but with no reasoning records, orphaned anchors, unconfirmed high-risk records, and stale deferred items. Each gap is scored — priority gaps (≥10) need attention now, quick wins (<10) are easy to address.",
    usage: [
      "claude-lore advisor gaps",
    ],
    flags: [],
    examples: [
      { command: "claude-lore advisor gaps", desc: "Scored gap report for this repo" },
    ],
    seeAlso: ["advisor", "review"],
  },

  {
    name: "advisor claudemd",
    group: "reviewing",
    summary: "CLAUDE.md optimisation suggestions.",
    description:
      "Analyses CLAUDE.md for token bloat, duplicate sections, outdated references, and missing sections. Suggests what to add, simplify, or remove. With --apply, makes the changes automatically.",
    usage: [
      "claude-lore advisor claudemd",
      "claude-lore advisor claudemd --apply",
    ],
    flags: [
      { flag: "--apply", desc: "Apply all suggestions automatically" },
    ],
    examples: [
      { command: "claude-lore advisor claudemd",          desc: "Show suggestions only" },
      { command: "claude-lore advisor claudemd --apply",  desc: "Apply all suggestions" },
    ],
    seeAlso: ["advisor", "bootstrap"],
  },

  {
    name: "advisor skills",
    group: "skills",
    summary: "Skill gap analysis from session patterns.",
    description:
      "Analyses session history to suggest new skills that would encode repeated patterns into reusable agent behaviours. For example, if your agent repeatedly looks up the same conventions, a skill would pre-load them.",
    usage: [
      "claude-lore advisor skills",
      "claude-lore advisor skills --days 30",
      "claude-lore advisor skills --generate <name>",
    ],
    flags: [
      { flag: "--days <n>",         desc: "Lookback window in days (default: 30)" },
      { flag: "--generate <name>",  desc: "Generate a skill stub file for a named suggestion" },
    ],
    examples: [
      { command: "claude-lore advisor skills",
        desc: "Suggestions based on last 30 days of sessions" },
      { command: "claude-lore advisor skills --generate auth-conventions",
        desc: "Create a skill stub file for auth-conventions" },
    ],
    seeAlso: ["skills", "skills --onboarding"],
  },

  {
    name: "advisor parallel",
    group: "reviewing",
    summary: "Tasks safe to run as parallel subagents.",
    description:
      "Analyses open deferred items (or a provided task list) for symbol overlap, file conflicts, and explicit dependencies. Returns groups of tasks that are safe to run as parallel Claude Code subagents, with ready-to-use subagent prompts.",
    usage: [
      "claude-lore advisor parallel",
      "claude-lore advisor parallel --from-deferred",
      "claude-lore advisor parallel --tasks 'task A,task B,task C'",
    ],
    flags: [
      { flag: "--from-deferred", desc: "Read open deferred items from DB (default)" },
      { flag: "--tasks <list>",  desc: "Comma-separated list of task descriptions to analyse" },
    ],
    examples: [
      { command: "claude-lore advisor parallel", desc: "Parallelism analysis of all open deferred items" },
    ],
    seeAlso: ["advisor", "review"],
  },

  {
    name: "advisor workflow",
    group: "reviewing",
    summary: "Workflow pattern analysis from session history.",
    description:
      "Analyses session history to detect anti-patterns: context switching (too many unrelated modules per session), decisions logged after implementation, late-session deferrals, and accumulating unconfirmed records.",
    usage: [
      "claude-lore advisor workflow",
      "claude-lore advisor workflow --days 60",
    ],
    flags: [
      { flag: "--days <n>", desc: "Lookback window in days (default: 60)" },
    ],
    examples: [
      { command: "claude-lore advisor workflow",          desc: "Workflow patterns from last 60 days" },
      { command: "claude-lore advisor workflow --days 14", desc: "Last 2 weeks only" },
    ],
    seeAlso: ["advisor", "review"],
  },

  {
    name: "graph decisions",
    group: "visualising",
    summary: "Decision hierarchy graph.",
    description:
      "Generates a visual graph of all decisions in this repo, showing how they relate to symbols and each other. Default format is Mermaid. With --open, writes an interactive D3 HTML file and opens it in your browser.",
    usage: [
      "claude-lore graph decisions",
      "claude-lore graph decisions --format html --open",
      "claude-lore graph decisions --format dot",
    ],
    flags: [
      { flag: "--format <fmt>", desc: "Output format: mermaid (default)|dot|html|json" },
      { flag: "--open",          desc: "Write HTML to /tmp and open in browser" },
      { flag: "--repo <path>",   desc: "Repo path (defaults to cwd)" },
    ],
    examples: [
      { command: "claude-lore graph decisions --open",         desc: "Interactive D3 graph in browser" },
      { command: "claude-lore graph decisions --format dot",   desc: "Graphviz dot output" },
    ],
    seeAlso: ["graph symbol", "annotate", "provenance"],
  },

  {
    name: "graph symbol",
    group: "visualising",
    summary: "Impact map for a specific symbol.",
    description:
      "Generates a blast-radius graph centred on a named symbol — showing all callers, all callees, and any reasoning records attached to that symbol or its neighbours.",
    usage: [
      "claude-lore graph symbol <name>",
      "claude-lore graph symbol <name> --open",
    ],
    flags: [
      { flag: "--format <fmt>", desc: "Output format: mermaid (default)|dot|html|json" },
      { flag: "--open",          desc: "Write HTML to /tmp and open in browser" },
      { flag: "--repo <path>",   desc: "Repo path (defaults to cwd)" },
    ],
    examples: [
      { command: "claude-lore graph symbol resolveIdentity --open",
        desc: "Impact graph for resolveIdentity in browser" },
    ],
    seeAlso: ["graph decisions", "provenance", "annotate"],
  },

  {
    name: "graph portfolio",
    group: "portfolio",
    summary: "Cross-repo dependency map.",
    description:
      "Generates a dependency map across all repos in the current portfolio. Shows which symbols are shared between repos and which repos depend on others.",
    usage: [
      "claude-lore graph portfolio",
      "claude-lore graph portfolio --open",
    ],
    flags: [
      { flag: "--format <fmt>",  desc: "Output format: mermaid (default)|dot|html|json" },
      { flag: "--open",           desc: "Write HTML to /tmp and open in browser" },
      { flag: "--repos <list>",   desc: "Comma-separated repo paths (defaults to all in portfolio)" },
    ],
    examples: [
      { command: "claude-lore graph portfolio --open", desc: "Cross-repo dependency graph in browser" },
    ],
    seeAlso: ["portfolio list", "portfolio status"],
  },

  {
    name: "annotate",
    group: "visualising",
    summary: "Source file with reasoning overlay.",
    description:
      "Generates an HTML view of a source file with reasoning annotations overlaid as colour-coded left-border indicators. Blue = decision, yellow = risk, grey = deferred. Opens in browser by default.",
    usage: [
      "claude-lore annotate <file_path>",
      "claude-lore annotate <file_path> --format text",
    ],
    flags: [
      { flag: "--format <fmt>", desc: "Output format: html (default, opens browser)|text|json" },
      { flag: "--repo <path>",  desc: "Repo path for record lookup (defaults to cwd)" },
    ],
    examples: [
      { command: "claude-lore annotate src/services/auth.ts",
        desc: "Annotated view of auth.ts in browser" },
      { command: "claude-lore annotate src/index.ts --format text",
        desc: "Text output with inline annotation markers" },
    ],
    seeAlso: ["provenance", "graph symbol"],
  },

  {
    name: "provenance",
    group: "visualising",
    summary: "Full chronological decision history for a symbol.",
    description:
      "Shows the complete history of how a symbol came to exist — all sessions that touched it, decisions made, alternatives rejected, and reasoning records in chronological order. Useful for understanding why something looks the way it does.",
    usage: [
      "claude-lore provenance <symbol>",
      "claude-lore provenance <symbol> --format mermaid",
      "claude-lore provenance <symbol> --open",
    ],
    flags: [
      { flag: "--format <fmt>", desc: "Output format: text (default)|html|mermaid|json" },
      { flag: "--open",          desc: "Write HTML to /tmp and open in browser" },
      { flag: "--repo <path>",   desc: "Repo path (defaults to cwd)" },
    ],
    examples: [
      { command: "claude-lore provenance resolveIdentity",
        desc: "Full history for resolveIdentity" },
      { command: "claude-lore provenance resolveIdentity --format mermaid",
        desc: "Mermaid timeline diagram" },
    ],
    seeAlso: ["annotate", "graph symbol"],
  },

  {
    name: "coverage",
    group: "visualising",
    summary: "Annotation coverage for this repo.",
    description:
      "Shows which symbols have reasoning records and which don't. Useful for finding gaps — high-caller symbols with no decisions, high-risk code with no risk records.",
    usage: [
      "claude-lore coverage",
      "claude-lore coverage --repo <path>",
    ],
    flags: [
      { flag: "--repo <path>", desc: "Repo path (defaults to cwd)" },
      { flag: "--cwd <dir>",   desc: "Directory to scan for source files (defaults to repo)" },
    ],
    examples: [
      { command: "claude-lore coverage", desc: "Coverage report for current repo" },
    ],
    seeAlso: ["annotate", "advisor gaps"],
  },

  {
    name: "review-map",
    group: "visualising",
    summary: "Codebase map coloured by reasoning coverage.",
    description:
      "Generates an interactive D3 force graph showing every source file and its import edges. Nodes are colour-coded: red=has risks, blue=has decisions, amber=has deferred work, grey=no reasoning. Entry-point files have a yellow border. Click any node to see its reasoning records and dependency list.",
    usage: [
      "claude-lore review-map",
      "claude-lore review-map --layout radial",
      "claude-lore review-map --format mermaid",
      "claude-lore review-map --no-open --format html > /tmp/map.html",
    ],
    flags: [
      { flag: "--format <fmt>",  desc: "Output format: html (default)|mermaid" },
      { flag: "--layout <l>",    desc: "Graph layout: force (default)|radial" },
      { flag: "--open",          desc: "Open in browser (default: on)" },
      { flag: "--no-open",       desc: "Write to /tmp but do not open" },
      { flag: "--repo <path>",   desc: "Repo path (defaults to cwd)" },
      { flag: "--cwd <dir>",     desc: "Directory to scan (defaults to repo)" },
    ],
    examples: [
      { command: "claude-lore review-map", desc: "Open force graph of current repo" },
      { command: "claude-lore review-map --layout radial", desc: "Radial layout" },
    ],
    seeAlso: ["review-diff", "review-propagation", "annotate", "coverage"],
  },

  {
    name: "review-diff",
    group: "visualising",
    summary: "Pre-commit review with reasoning overlay.",
    description:
      "Generates an HTML report showing the current git diff side-by-side with any reasoning records (decisions, risks, deferred items) associated with each changed file. Files with warnings (e.g. risks attached, large changes to decision-heavy files) are automatically expanded. Safe to run multiple times — read-only.",
    usage: [
      "claude-lore review-diff",
      "claude-lore review-diff --base main",
      "claude-lore review-diff --format json",
    ],
    flags: [
      { flag: "--format <fmt>", desc: "Output format: html (default)|json" },
      { flag: "--base <ref>",   desc: "Git base ref (default: HEAD)" },
      { flag: "--open",         desc: "Open in browser (default: on)" },
      { flag: "--no-open",      desc: "Write to /tmp but do not open" },
      { flag: "--repo <path>",  desc: "Repo path (defaults to cwd)" },
      { flag: "--cwd <dir>",    desc: "Working directory (defaults to repo)" },
    ],
    examples: [
      { command: "claude-lore review-diff", desc: "Review uncommitted changes vs HEAD" },
      { command: "claude-lore review-diff --base main", desc: "Review everything not yet on main" },
    ],
    seeAlso: ["review-map", "review-propagation", "adr list"],
  },

  {
    name: "review-propagation",
    group: "visualising",
    summary: "Files transitively affected by changing a given file.",
    description:
      "Shows the full propagation blast-radius of a single file change. Starting from the focus file, walks outward through all files that import it (directly or transitively) and renders a D3 graph with reasoning overlay. Useful before refactoring a shared module.",
    usage: [
      "claude-lore review-propagation <file>",
      "claude-lore review-propagation src/services/auth.ts",
    ],
    flags: [
      { flag: "--format <fmt>", desc: "Output format: html (default)|json" },
      { flag: "--open",         desc: "Open in browser (default: on)" },
      { flag: "--no-open",      desc: "Write to /tmp but do not open" },
      { flag: "--repo <path>",  desc: "Repo path (defaults to cwd)" },
      { flag: "--cwd <dir>",    desc: "Working directory (defaults to repo)" },
    ],
    examples: [
      { command: "claude-lore review-propagation src/utils/db.ts",
        desc: "All files affected by changing db.ts" },
    ],
    seeAlso: ["review-map", "review-diff", "graph symbol"],
  },

  {
    name: "portfolio create",
    group: "portfolio",
    summary: "Create a named group of related repos.",
    description:
      "Creates a named portfolio — a logical group of repos that share cross-repo context, dependencies, and portfolio-level decisions. Use portfolios to enable cross-repo impact analysis.",
    usage: [
      "claude-lore portfolio create <name>",
      "claude-lore portfolio create <name> --description <desc>",
    ],
    flags: [
      { flag: "--description <desc>", desc: "Optional description for the portfolio" },
    ],
    examples: [
      { command: "claude-lore portfolio create security-platform",
        desc: "Create a portfolio named security-platform" },
    ],
    seeAlso: ["portfolio add", "portfolio list", "portfolio init"],
  },

  {
    name: "portfolio add",
    group: "portfolio",
    summary: "Add a repo to a portfolio.",
    description:
      "Adds a repo to an existing portfolio and syncs its exports.manifest to the global registry so other repos in the portfolio can reference its shared symbols.",
    usage: [
      "claude-lore portfolio add <name> <repo-path>",
    ],
    flags: [],
    examples: [
      { command: "claude-lore portfolio add security-platform ~/projects/auth-service",
        desc: "Add auth-service to the security-platform portfolio" },
    ],
    seeAlso: ["portfolio create", "portfolio list", "portfolio sync"],
  },

  {
    name: "portfolio remove",
    group: "portfolio",
    summary: "Remove a repo from a portfolio.",
    description: "Removes a repo from a portfolio and cleans up its cross-repo index entries.",
    usage: [
      "claude-lore portfolio remove <name> <repo-path>",
    ],
    flags: [],
    examples: [
      { command: "claude-lore portfolio remove security-platform ~/projects/auth-service",
        desc: "Remove auth-service from the security-platform portfolio" },
    ],
    seeAlso: ["portfolio add", "portfolio list"],
  },

  {
    name: "portfolio list",
    group: "portfolio",
    summary: "List all portfolios and their repos.",
    description: "Shows all portfolios and the repos they contain, with last-sync timestamps.",
    usage: [
      "claude-lore portfolio list",
      "claude-lore portfolio list --json",
    ],
    flags: [
      { flag: "--json", desc: "Output as JSON" },
    ],
    examples: [
      { command: "claude-lore portfolio list", desc: "All portfolios and repos" },
    ],
    seeAlso: ["portfolio create", "portfolio status"],
  },

  {
    name: "portfolio sync",
    group: "portfolio",
    summary: "Re-sync all repos in a portfolio to the registry.",
    description:
      "Reads the exports.manifest for each repo in the portfolio and syncs the exported symbols to the global registry. Run after adding new symbols to a shared module.",
    usage: [
      "claude-lore portfolio sync <name>",
    ],
    flags: [],
    examples: [
      { command: "claude-lore portfolio sync security-platform",
        desc: "Sync all repos in the security-platform portfolio" },
    ],
    seeAlso: ["portfolio add", "portfolio status"],
  },

  {
    name: "portfolio status",
    group: "portfolio",
    summary: "Cross-repo relationship summary.",
    description:
      "Shows the dependency relationships between repos in a portfolio — which symbols are shared, which repos depend on others, and any cross-repo risks.",
    usage: [
      "claude-lore portfolio status <name>",
      "claude-lore portfolio status <name> --json",
    ],
    flags: [
      { flag: "--json", desc: "Output as JSON" },
    ],
    examples: [
      { command: "claude-lore portfolio status security-platform",
        desc: "Relationship summary for the security-platform portfolio" },
    ],
    seeAlso: ["portfolio list", "portfolio sync", "graph portfolio"],
  },

  {
    name: "portfolio init",
    group: "portfolio",
    summary: "Interactive portfolio setup.",
    description:
      "Interactive wizard that creates a portfolio, links repos, and syncs all manifests in one step. Recommended for first-time portfolio setup.",
    usage: [
      "claude-lore portfolio init <name>",
    ],
    flags: [],
    examples: [
      { command: "claude-lore portfolio init security-platform",
        desc: "Interactive setup for a new portfolio" },
    ],
    seeAlso: ["portfolio create", "portfolio add"],
  },

  {
    name: "adr list",
    group: "adr",
    summary: "Pending ADR candidates from sessions.",
    description:
      "Lists decisions captured during sessions that are strong candidates for formal ADRs — high-blast-radius changes, decisions that contradicted prior records, and decisions mentioned across multiple sessions.",
    usage: [
      "claude-lore adr list",
    ],
    flags: [],
    examples: [
      { command: "claude-lore adr list", desc: "All pending ADR candidates for current repo" },
    ],
    seeAlso: ["adr confirm", "adr discard", "adr post-pr"],
  },

  {
    name: "adr confirm",
    group: "adr",
    summary: "Promote a decision to accepted.",
    description:
      "Marks an ADR candidate as accepted and promotes its confidence to 'confirmed'. The decision will now be treated as ground truth by the agent.",
    usage: [
      "claude-lore adr confirm <id>",
    ],
    flags: [],
    examples: [
      { command: "claude-lore adr confirm d-a3f2b1", desc: "Accept decision d-a3f2b1 as an ADR" },
    ],
    seeAlso: ["adr list", "adr discard"],
  },

  {
    name: "adr discard",
    group: "adr",
    summary: "Archive a superseded decision.",
    description:
      "Marks an ADR candidate as superseded/archived. The record is kept for history but no longer surfaced as an active decision.",
    usage: [
      "claude-lore adr discard <id>",
    ],
    flags: [],
    examples: [
      { command: "claude-lore adr discard d-a3f2b1", desc: "Archive decision d-a3f2b1" },
    ],
    seeAlso: ["adr list", "adr confirm"],
  },

  {
    name: "adr post-pr",
    group: "adr",
    summary: "Post ADR candidates as GitHub PR comments.",
    description:
      "Uses the gh CLI to post all pending ADR candidates as comments on the current PR. Useful for team review of captured decisions before they're formally confirmed.",
    usage: [
      "claude-lore adr post-pr",
    ],
    flags: [],
    examples: [
      { command: "claude-lore adr post-pr", desc: "Post all pending ADR candidates on the current PR" },
    ],
    seeAlso: ["adr list", "adr confirm"],
  },

  {
    name: "skills",
    group: "skills",
    summary: "Show skill manifest for this repo.",
    description:
      "Shows global and repo-level skill counts and detects conflicts. With --onboarding, compares your local skills against the team's canonical set. With --diff, shows detailed conflict breakdown.",
    usage: [
      "claude-lore skills",
      "claude-lore skills --onboarding",
      "claude-lore skills --diff",
    ],
    flags: [
      { flag: "--onboarding", desc: "Show what you're missing vs the team standard" },
      { flag: "--diff",       desc: "Skill drift across repos in portfolio" },
    ],
    examples: [
      { command: "claude-lore skills",              desc: "Skill counts and conflict summary" },
      { command: "claude-lore skills --onboarding", desc: "What you need to install to match the team" },
      { command: "claude-lore skills --diff",       desc: "Detailed version drift breakdown" },
    ],
    seeAlso: ["skills install", "advisor skills"],
  },

  {
    name: "import",
    group: "importing",
    summary: "Scan docs and git history for reasoning records.",
    description:
      "Discovers and imports decisions, risks, and deferred items from .md files, ADRs, and git history. The bootstrap command runs this automatically — use import directly for incremental updates after adding new documentation.",
    usage: [
      "claude-lore import",
      "claude-lore import --dry-run",
      "claude-lore import --file <file>",
      "claude-lore import --path <dir>",
    ],
    flags: [
      { flag: "--dry-run",    desc: "Preview records without writing" },
      { flag: "--file <f>",   desc: "Import from a single markdown file" },
      { flag: "--path <dir>", desc: "Scan a specific subdirectory" },
    ],
    examples: [
      { command: "claude-lore import",           desc: "Import from all docs in cwd" },
      { command: "claude-lore import --dry-run", desc: "Preview what would be imported" },
      { command: "claude-lore import --file docs/adr/0012.md",
        desc: "Import from a single ADR" },
    ],
    seeAlso: ["bootstrap", "review"],
  },

  {
    name: "worker start",
    group: "system",
    summary: "Start the background worker via PM2.",
    description:
      "Starts the claude-lore background worker on port 37778 using PM2. The worker handles all hook events, AI compression passes, and MCP tool requests. Must be running for hooks to work.",
    usage: [
      "claude-lore worker start",
    ],
    flags: [],
    examples: [
      { command: "claude-lore worker start", desc: "Start the worker" },
    ],
    seeAlso: ["worker stop", "worker status", "doctor"],
  },

  {
    name: "worker stop",
    group: "system",
    summary: "Stop the background worker.",
    description: "Stops the background worker via PM2.",
    usage: [
      "claude-lore worker stop",
    ],
    flags: [],
    examples: [
      { command: "claude-lore worker stop", desc: "Stop the worker" },
    ],
    seeAlso: ["worker start", "worker status"],
  },

  {
    name: "worker status",
    group: "system",
    summary: "Check worker health and uptime.",
    description: "Shows the PM2 status of the worker process and confirms the health endpoint responds.",
    usage: [
      "claude-lore worker status",
    ],
    flags: [],
    examples: [
      { command: "claude-lore worker status", desc: "Worker process status" },
    ],
    seeAlso: ["worker start", "doctor"],
  },

  {
    name: "auth generate",
    group: "system",
    summary: "Generate a per-developer auth token.",
    description:
      "Generates an auth token for a named developer with specified scopes. Tokens are stored in the worker and used to authenticate write operations in team mode.",
    usage: [
      "claude-lore auth generate <author>",
      "claude-lore auth generate <author> --scopes read,write:sessions,write:decisions",
    ],
    flags: [
      { flag: "--scopes <list>", desc: "Comma-separated scopes (default: read,write:sessions,write:decisions)" },
    ],
    examples: [
      { command: "claude-lore auth generate alice",
        desc: "Generate a token for alice with default scopes" },
    ],
    seeAlso: ["auth list", "auth revoke"],
  },

  {
    name: "auth list",
    group: "system",
    summary: "List active auth tokens.",
    description: "Lists all active tokens with author, creation date, and scopes. Token values are masked.",
    usage: [
      "claude-lore auth list",
    ],
    flags: [],
    examples: [
      { command: "claude-lore auth list", desc: "All active tokens" },
    ],
    seeAlso: ["auth generate", "auth revoke"],
  },

  {
    name: "auth revoke",
    group: "system",
    summary: "Revoke an auth token.",
    description: "Permanently revokes a token by its value. The token immediately loses access.",
    usage: [
      "claude-lore auth revoke <token>",
    ],
    flags: [],
    examples: [
      { command: "claude-lore auth revoke clore_abc123", desc: "Revoke a specific token" },
    ],
    seeAlso: ["auth list", "auth generate"],
  },

  {
    name: "agents list",
    group: "system",
    summary: "List available specialist agents.",
    description:
      "Shows all bundled specialist agents — blast-radius-checker, adr-drafter, session-handover, code-reviewer, cross-repo-validator — with brief descriptions.",
    usage: [
      "claude-lore agents list",
    ],
    flags: [],
    examples: [
      { command: "claude-lore agents list", desc: "All available agents" },
    ],
    seeAlso: ["agents run"],
  },

  {
    name: "agents run",
    group: "system",
    summary: "Print the system prompt for a named agent.",
    description:
      "Outputs the full system prompt for a named agent. Used to run specialist agents directly in Claude Code by pasting the prompt, or to review agent behaviour.",
    usage: [
      "claude-lore agents run <agent>",
      "claude-lore agents run blast-radius-checker --symbol <name>",
    ],
    flags: [
      { flag: "--symbol <name>", desc: "Symbol name (used by blast-radius-checker and cross-repo-validator)" },
    ],
    examples: [
      { command: "claude-lore agents run adr-drafter",
        desc: "Print the ADR drafter agent prompt" },
      { command: "claude-lore agents run blast-radius-checker --symbol resolveIdentity",
        desc: "Print blast-radius prompt for resolveIdentity" },
    ],
    seeAlso: ["agents list"],
  },
];

// ---------------------------------------------------------------------------
// Quick lookup map
// ---------------------------------------------------------------------------

export const COMMAND_MAP = new Map<string, CommandHelp>(
  CLI_COMMANDS.map((c) => [c.name, c]),
);

// ---------------------------------------------------------------------------
// Group ordering and labels
// ---------------------------------------------------------------------------

export const GROUP_ORDER: HelpGroup[] = [
  "getting-started",
  "reviewing",
  "querying",
  "visualising",
  "portfolio",
  "adr",
  "skills",
  "importing",
  "system",
];

export const GROUP_LABELS: Record<HelpGroup, string> = {
  "getting-started": "GETTING STARTED",
  "reviewing":       "REVIEWING KNOWLEDGE",
  "querying":        "QUERYING (inside Claude Code or Cursor)",
  "visualising":     "VISUALISING",
  "portfolio":       "PORTFOLIO (multi-repo)",
  "adr":             "ADR WORKFLOW",
  "skills":          "SKILLS",
  "importing":       "IMPORTING",
  "system":          "WORKER & SYSTEM",
};

// ---------------------------------------------------------------------------
// /lore in-chat commands
// ---------------------------------------------------------------------------

export const LORE_COMMANDS: LoreCommandHelp[] = [
  {
    command: "/lore <question>",
    summary: "Ask anything about this codebase in natural language.",
    mcp_tools: ["reasoning_get", "session_load", "codegraph_context", "portfolio_deps"],
    detail: `Natural language graph query. The graph is searched and grounded facts are returned separately from analysis, with confidence levels on every fact.

Response format:
  FACTS — only what the graph returned (cited)
  ANALYSIS — agent reasoning over the facts
  GAPS — what couldn't be determined`,
    example: `/lore why is auth written this way?
/lore what breaks if I change the telemetry schema?
/lore what did we decide about identity resolution?
/lore what's deferred on the Neptune migration?
/lore show me all high-severity risks`,
  },

  {
    command: "/lore help",
    summary: "Full command reference inside Claude Code.",
    mcp_tools: ["get_lore_help"],
    detail: "Shows this reference card. For help on a specific command, use /lore help <command>.",
    example: "/lore help\n/lore help improve",
  },

  {
    command: "/lore improve",
    summary: "All advisor recommendations in conversational prose.",
    mcp_tools: ["advisor_summary"],
    detail: `Shows all advisor recommendations for this repo:
  • CLAUDE.md sections that duplicate confirmed graph records (with token savings)
  • Knowledge gaps needing attention
  • Tasks that can run as parallel Claude Code subagents
  • Workflow patterns detected from session history

Calls advisor_summary(repo, cwd) which runs all four advisor services in parallel.`,
    example: `/lore improve
→ Your CLAUDE.md is 6,200 tokens — consider moving the API reference tables.
→ 3 deferred items can run in parallel today.
→ High-priority gap: resolveIdentity (8 sessions, no confirmed ADR).`,
  },

  {
    command: "/lore workflow",
    summary: "Workflow patterns and suggestions from session history.",
    mcp_tools: ["workflow_summary"],
    detail: `Workflow patterns detected from your last 60 days of sessions:
  • Context switching (3+ unrelated modules per session)
  • Decision-after-implementation (decisions logged after writes began)
  • Late-session deferrals (deferral keywords in last 20% of session)
  • Unconfirmed accumulation (extracted/inferred ratio > 70%)

Responses are conversational — not CLI output format.`,
  },

  {
    command: "/lore parallel",
    summary: "Which open deferred items can run as parallel subagents.",
    mcp_tools: ["parallelism_check"],
    detail: `Analyses open deferred items for symbol overlap, file conflicts, and explicit dependencies. Returns groups safe to run simultaneously, with ready-to-use subagent prompts.

Explain which tasks are safe and why (no shared symbols), which need sequencing, and provide the exact subagent prompt for each parallelisable group.`,
  },

  {
    command: "/lore skills",
    summary: "Skills gap report vs team canonical skills.",
    mcp_tools: ["annotation_coverage"],
    detail: `Shows which canonical team skills you have installed, which are missing, and the exact commands to install them. Also shows local skills not used by the team.`,
  },

  {
    command: "/lore status",
    summary: "Current session context summary.",
    mcp_tools: ["session_load"],
    detail: "Shows the context injected at session start: last session summary, open deferred items, high-confidence decisions, and active risks.",
  },

  {
    command: "/lore save <text>",
    summary: "Capture a decision, risk, or deferred item.",
    mcp_tools: ["reasoning_log"],
    detail: `Type is auto-detected from your phrasing:
  "decided", "chose", "using", "went with" → decision
  "risk", "concern", "vulnerable", "could fail" → risk
  "defer", "later", "TODO", "not now", "parked" → deferred

All saved records get confidence: extracted. Only humans can promote to confirmed.`,
    example: `/lore save we decided to use probabilistic scoring because deterministic lookup creates PII linkage risk
/lore save risk: session token storage does not meet new compliance requirements
/lore save defer: add rate limiting to /api/sessions/observations — not blocking v1`,
  },

  {
    command: "/lore log decision <text>",
    summary: "Explicitly log a decision record.",
    mcp_tools: ["reasoning_log"],
    detail: "Always writes type 'decision', regardless of phrasing.",
    example: "/lore log decision port 37778 chosen to avoid collision with claude-mem on 37777",
  },

  {
    command: "/lore log risk <text>",
    summary: "Explicitly log a risk record.",
    mcp_tools: ["reasoning_log"],
    detail: "Always writes type 'risk'.",
    example: "/lore log risk personal.db must never be synced — contains developer-only notes",
  },

  {
    command: "/lore log defer <text>",
    summary: "Explicitly log a deferred work item.",
    mcp_tools: ["reasoning_log"],
    detail: "Always writes type 'deferred_work'.",
    example: "/lore log defer add Turso sync support to personal.db — currently local only",
  },

  {
    command: "/lore review",
    summary: "Show all pending unconfirmed records.",
    mcp_tools: ["reasoning_get"],
    detail: "Shows all records with confidence 'extracted' or 'inferred'. Use /lore confirm <id> to promote a record to confirmed.",
  },

  {
    command: "/lore confirm <id>",
    summary: "Confirm a pending record.",
    mcp_tools: ["reasoning_log"],
    detail: "Promotes confidence from 'extracted' or 'inferred' to 'confirmed'. Confirmed records carry more weight with your agent.",
    example: "/lore confirm dec-abc123\n/lore confirm risk-def456",
  },

  {
    command: "/lore bootstrap",
    summary: "Run the bootstrap wizard for this repo.",
    mcp_tools: [],
    detail: "Equivalent to claude-lore bootstrap in the terminal. Use when the worker is already running and you want to bootstrap without leaving Claude Code.",
  },

  {
    command: "/lore graph",
    summary: "Open the decision hierarchy graph in browser.",
    mcp_tools: [],
    detail: "Equivalent to claude-lore graph decisions --open. Generates an interactive D3 HTML graph and opens it.",
  },

  {
    command: "/lore annotate <file>",
    summary: "Open source file with reasoning annotations in browser.",
    mcp_tools: ["annotate_file"],
    detail: "Generates an HTML view with colour-coded left-border indicators for decisions, risks, and deferred items. Opens in browser.",
    example: "/lore annotate src/services/auth.ts",
  },

  {
    command: "/lore provenance <symbol>",
    summary: "Full chronological history of how a symbol came to exist.",
    mcp_tools: ["provenance_trace"],
    detail: "Shows all sessions that touched this symbol, decisions made, alternatives rejected, and reasoning records in chronological order.",
    example: "/lore provenance resolveIdentity",
  },
];

export const LORE_COMMAND_MAP = new Map<string, LoreCommandHelp>(
  LORE_COMMANDS.map((c) => {
    // Key by the main command word after /lore
    const key = c.command.replace("/lore ", "").split(" ")[0]!;
    return [key, c];
  }),
);
