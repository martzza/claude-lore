// ---------------------------------------------------------------------------
// /lore in-chat help data for the worker's get_lore_help MCP tool
// Mirrors the LoreCommandHelp entries in packages/cli/src/help.ts
// ---------------------------------------------------------------------------

export interface LoreHelpEntry {
  command:   string;
  summary:   string;
  detail:    string;
  example?:  string;
  mcp_tools: string[];
}

export const LORE_HELP: LoreHelpEntry[] = [
  {
    command: "/lore <question>",
    summary: "Ask anything about this codebase in natural language.",
    mcp_tools: ["reasoning_get", "session_load", "codegraph_context", "portfolio_deps"],
    detail: `Natural language graph query. The graph is searched and grounded facts are returned separately from analysis, with confidence levels on every fact.

Response format:
  FACTS — only what the graph returned (cited, with confidence prefix)
  ANALYSIS — agent reasoning over the facts (clearly labelled as inference)
  GAPS — what couldn't be determined (always present, drives future capture)`,
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
    detail: "Shows the full in-chat reference. For help on a specific command: /lore help <command>.",
    example: "/lore help\n/lore help improve\n/lore help parallel",
  },

  {
    command: "/lore improve",
    summary: "All advisor recommendations in conversational prose.",
    mcp_tools: ["advisor_summary"],
    detail: `Shows all advisor recommendations for this repo in one place. Covers:

• CLAUDE.md — sections that duplicate confirmed graph records, with token savings estimate
• Knowledge gaps — symbols touched frequently with no reasoning records
• Parallel tasks — open deferred items safe to run as parallel subagents (with ready-to-use prompts)
• Workflow patterns — anti-patterns detected from session history

How it works: calls advisor_summary(repo, cwd) which runs all four advisor services in parallel and returns consolidated findings. Present findings in conversational prose — not CLI output format, not raw JSON.`,
    example: `Here are the current recommendations for intellidx:

CLAUDE.md (2 findings)
• "Database layer" section duplicates 2 confirmed decisions (~180 tokens/session)
• Decision "Use probabilistic scoring" not yet in CLAUDE.md — consider adding
Run: claude-lore advisor claudemd --apply

KNOWLEDGE GAPS (2 priority gaps)
• resolveIdentity — touched 8 sessions, no confirmed ADR
  Action: /lore log decision why resolveIdentity uses probabilistic scoring
• Risk R-041 (PII linkage) — HIGH, unconfirmed 14 days
  Action: /lore confirm r-041

PARALLEL TASKS (3 tasks safe to parallelise)
• "Add validation to auth endpoints" — no shared symbols
• "Update telemetry schema" — independent module

Highest priority: confirm r-041 and resolveIdentity decision today.`,
  },

  {
    command: "/lore workflow",
    summary: "Workflow patterns and suggestions from session history.",
    mcp_tools: ["workflow_summary"],
    detail: `Analyses session history to detect anti-patterns:
• Context switching (3+ unrelated modules per session)
• Decision-after-implementation (decisions logged after writes began)
• Late-session deferrals (deferral keywords in final 20% of session)
• Unconfirmed accumulation (extracted/inferred ratio > 70%)

Respond conversationally — explain what the patterns mean and what to do differently, not just names.`,
  },

  {
    command: "/lore parallel",
    summary: "Which open deferred items can run as parallel subagents.",
    mcp_tools: ["parallelism_check"],
    detail: `Analyses open deferred items for symbol overlap, file conflicts, and explicit dependencies. Groups items that are safe to run simultaneously and generates ready-to-use subagent prompts.

For each parallelisable group, explain:
• Which tasks are in the group and why they're safe (no shared symbols)
• The exact subagent prompt to use
• Estimated speedup vs sequential execution

Also explain which tasks must run sequentially and why.`,
  },

  {
    command: "/lore skills",
    summary: "Skills gap report vs team canonical skills.",
    mcp_tools: ["annotation_coverage"],
    detail: `Compares your locally installed skills against the team's canonical skill set for this repo.

Shows:
• Which canonical skills you have installed and are up to date
• Which are missing or have version drift
• Exact install commands for missing skills
• Local skills you have that the team doesn't use (not a problem)`,
  },

  {
    command: "/lore status",
    summary: "Current session context summary.",
    mcp_tools: ["session_load"],
    detail: "Shows the context injected at session start: last session summary, open deferred items, high-confidence decisions, and active risks.",
  },

  {
    command: "/lore save",
    summary: "Capture a decision, risk, or deferred item.",
    mcp_tools: ["reasoning_log"],
    detail: `Type is auto-detected from your phrasing:
  "decided", "chose", "using", "went with" → decision
  "risk", "concern", "vulnerable", "could fail" → risk
  "defer", "later", "TODO", "not now", "parked" → deferred

All saved records get confidence: extracted. Only humans can promote to confirmed via /lore confirm or claude-lore review.`,
    example: `/lore save we decided to use probabilistic scoring because deterministic lookup creates PII linkage risk
/lore save risk: session token storage does not meet new compliance requirements
/lore save defer: add rate limiting to /api/sessions/observations — not blocking v1`,
  },

  {
    command: "/lore review",
    summary: "Show all pending unconfirmed records.",
    mcp_tools: ["reasoning_get"],
    detail: "Shows all records with confidence 'extracted' or 'inferred'. Use /lore confirm <id> to promote a record to confirmed. Confirmed records carry more weight with your agent.",
  },

  {
    command: "/lore confirm",
    summary: "Confirm a pending record.",
    mcp_tools: ["reasoning_log"],
    detail: "Promotes confidence from 'extracted' or 'inferred' to 'confirmed'. Confirmed records are treated as ground truth.",
    example: "/lore confirm dec-abc123",
  },

  {
    command: "/lore bootstrap",
    summary: "Run the bootstrap wizard for this repo.",
    mcp_tools: [],
    detail: "Equivalent to claude-lore bootstrap in the terminal. Pre-populates the knowledge graph from documentation and security templates.",
  },

  {
    command: "/lore graph",
    summary: "Open decision hierarchy graph in browser.",
    mcp_tools: [],
    detail: "Equivalent to claude-lore graph decisions --open. Generates an interactive D3 HTML graph of all decisions and opens it in your browser.",
  },

  {
    command: "/lore annotate",
    summary: "Open source file with reasoning annotations in browser.",
    mcp_tools: ["annotate_file"],
    detail: "Generates an HTML view with colour-coded left-border indicators showing which lines have decisions, risks, or deferred items attached.",
    example: "/lore annotate src/services/auth.ts",
  },

  {
    command: "/lore provenance",
    summary: "Full chronological history of how a symbol came to exist.",
    mcp_tools: ["provenance_trace"],
    detail: "Shows all sessions that touched this symbol, decisions made, alternatives rejected, and reasoning records in chronological order.",
    example: "/lore provenance resolveIdentity",
  },
];

export const LORE_HELP_MAP = new Map<string, LoreHelpEntry>(
  LORE_HELP.map((h) => {
    const key = h.command.replace("/lore ", "").split(" ")[0]!;
    return [key, h];
  }),
);

// ---------------------------------------------------------------------------
// Render functions
// ---------------------------------------------------------------------------

const DIVIDER = "──────────────────────────────────────────";

export function renderFullReference(): string {
  const lines: string[] = [
    "claude-lore — in-session command reference",
    DIVIDER,
    "",
    "ASKING QUESTIONS",
  ];

  const question = LORE_HELP_MAP.get("<question>");
  if (question) {
    lines.push(`  /lore <question>`);
    lines.push(`    ${question.summary}`);
    lines.push(`    The graph is searched and grounded facts are returned separately`);
    lines.push(`    from analysis, with confidence levels on every fact.`);
    lines.push(`    Response format: FACTS / ANALYSIS / GAPS`);
    lines.push(``);
    lines.push(`    Examples:`);
    lines.push(`      /lore why is auth written this way?`);
    lines.push(`      /lore what breaks if I change the telemetry schema?`);
    lines.push(`      /lore what did we decide about X?`);
    lines.push(`      /lore show me all high-severity risks`);
    lines.push(``);
  }

  lines.push("CAPTURING KNOWLEDGE");
  lines.push(`  /lore save <text>`);
  lines.push(`    Capture a decision, risk, or deferred item right now.`);
  lines.push(`    Type is auto-detected from your phrasing.`);
  lines.push(`    Example: /lore save we decided to use probabilistic scoring`);
  lines.push(`             because deterministic lookup creates PII linkage risk`);
  lines.push(``);
  lines.push(`  /lore log decision <text>   Explicitly log a decision`);
  lines.push(`  /lore log risk <text>       Explicitly log a risk`);
  lines.push(`  /lore log defer <text>      Explicitly log a deferred item`);
  lines.push(``);

  lines.push("REVIEWING AND CONFIRMING");
  lines.push(`  /lore review`);
  lines.push(`    Show all unconfirmed records (confidence: extracted or inferred).`);
  lines.push(`    Confirmed records carry more weight with your agent.`);
  lines.push(``);
  lines.push(`  /lore confirm <id>`);
  lines.push(`    Confirm a specific record. Example: /lore confirm d-a3f2b1`);
  lines.push(``);
  lines.push(`  /lore status`);
  lines.push(`    Show what context your agent has right now — decisions,`);
  lines.push(`    risks, deferred items, and last session summary.`);
  lines.push(``);

  lines.push("ADVISOR AND IMPROVEMENTS");
  lines.push(`  /lore improve`);
  lines.push(`    All advisor recommendations: CLAUDE.md issues, knowledge gaps,`);
  lines.push(`    parallel tasks, workflow patterns.`);
  lines.push(``);
  lines.push(`  /lore workflow`);
  lines.push(`    Workflow patterns from last 60 days (context switching, late`);
  lines.push(`    deferrals, decision-after-implementation).`);
  lines.push(``);
  lines.push(`  /lore parallel`);
  lines.push(`    Open deferred items safe to run as parallel subagents,`);
  lines.push(`    with ready-to-use subagent prompts.`);
  lines.push(``);

  lines.push("VISUALISING (opens in browser)");
  lines.push(`  /lore graph`);
  lines.push(`    Decision hierarchy as an interactive D3 graph.`);
  lines.push(``);
  lines.push(`  /lore annotate <file>`);
  lines.push(`    Source file with reasoning annotations overlaid.`);
  lines.push(`    Example: /lore annotate src/services/auth.ts`);
  lines.push(``);
  lines.push(`  /lore provenance <symbol>`);
  lines.push(`    Chronological history of how a symbol came to exist.`);
  lines.push(`    Example: /lore provenance resolveIdentity`);
  lines.push(``);

  lines.push("BOOTSTRAP AND SETUP");
  lines.push(`  /lore bootstrap`);
  lines.push(`    Run the bootstrap wizard to pre-populate this repo's`);
  lines.push(`    knowledge graph from documentation and security templates.`);
  lines.push(``);

  lines.push(DIVIDER);
  lines.push("For help on a specific command:");
  lines.push("  /lore help <command>");
  lines.push("  Example: /lore help improve");
  lines.push("");
  lines.push("For CLI help (run in terminal):");
  lines.push("  claude-lore help");
  lines.push("  claude-lore help bootstrap");
  lines.push("  claude-lore doctor");
  lines.push(DIVIDER);

  return lines.join("\n");
}

export function renderCommandHelp(command: string): string {
  const key = command.replace(/^\/lore\s+/, "").split(" ")[0]!.toLowerCase();
  const entry = LORE_HELP_MAP.get(key) ?? LORE_HELP_MAP.get(`<${key}>`);

  if (!entry) {
    return `No help found for '/lore ${command}'. Type /lore help to see all commands.`;
  }

  const lines: string[] = [
    `${entry.command} — ${entry.summary}`,
    DIVIDER,
    "",
    "WHAT IT DOES",
    ...entry.detail.split("\n").map((l) => (l.trim() ? `  ${l}` : l)),
    "",
  ];

  if (entry.mcp_tools.length > 0) {
    lines.push("MCP TOOLS USED");
    lines.push(`  ${entry.mcp_tools.join(", ")}`);
    lines.push("");
  }

  if (entry.example) {
    lines.push("EXAMPLES");
    for (const ex of entry.example.split("\n")) {
      lines.push(`  ${ex}`);
    }
    lines.push("");
  }

  lines.push(DIVIDER);
  lines.push("For the full reference: /lore help");

  return lines.join("\n");
}
