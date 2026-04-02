import {
  CLI_COMMANDS,
  COMMAND_MAP,
  GROUP_ORDER,
  GROUP_LABELS,
  type HelpGroup,
} from "../help.js";

const VERSION = "1.0.0";
const DIVIDER = "─────────────────────────────────────────────────────────────";

function printGroupedHelp(): void {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║  claude-lore — knowledge graph for AI coding agents        ║");
  console.log(`║  v${VERSION}                                                    ║`);
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  // Group commands
  const byGroup = new Map<HelpGroup, typeof CLI_COMMANDS>();
  for (const g of GROUP_ORDER) byGroup.set(g, []);
  for (const cmd of CLI_COMMANDS) {
    byGroup.get(cmd.group)?.push(cmd);
  }

  console.log("GETTING STARTED");
  console.log("  init              Set up this repo — creates .codegraph/,");
  console.log("                    starts worker, registers Claude Code hooks");
  console.log("  bootstrap         Pre-populate from docs, ADRs, git history");
  console.log("                    and security templates");
  console.log("  doctor            Verify everything is wired up correctly");
  console.log("  update            Rebuild CLI and restart worker\n");

  console.log("REVIEWING KNOWLEDGE");
  console.log("  review            List unconfirmed records — confirm or discard");
  console.log("  audit             Cross-check bootstrap claims against code reality");
  console.log("    audit --estimate  Preview cost before running (free, instant)");
  console.log("    audit --grep-only Run without LLM — no API key required");
  console.log("  status            Current repo state at a glance");
  console.log("  advisor           Workflow and gap suggestions");
  console.log("    advisor gaps      Knowledge gaps needing attention");
  console.log("    advisor claudemd  CLAUDE.md optimisation suggestions");
  console.log("    advisor skills    Skill gap analysis");
  console.log("    advisor parallel  Tasks safe to run as parallel subagents");
  console.log("    advisor workflow  Workflow pattern analysis from session history\n");

  console.log("QUERYING (inside Claude Code or Cursor)");
  console.log("  /lore <question>     Ask anything about this codebase");
  console.log("  /lore help           Full command reference inside Claude Code");
  console.log("  /lore improve        All advisor recommendations");
  console.log("  /lore workflow       Workflow patterns and suggestions");
  console.log("  /lore parallel       Tasks safe to run in parallel");
  console.log("  /lore status         Current session context summary");
  console.log("  /lore save <text>    Capture a decision or risk now");
  console.log("  /lore review         Show pending unconfirmed records");
  console.log("  /lore audit          Review audit gap records inline\n");

  console.log("VISUALISING");
  console.log("  graph decisions      Decision hierarchy (Mermaid / interactive D3)");
  console.log("  graph symbol <name>  Impact map for a symbol");
  console.log("  graph portfolio      Cross-repo dependency map");
  console.log("  annotate <file>      Source file with reasoning overlay");
  console.log("  provenance <symbol>  How a symbol came to exist");
  console.log("  coverage             Annotation coverage for this repo\n");

  console.log("PORTFOLIO (multi-repo)");
  console.log("  portfolio create     Create a named group of related repos");
  console.log("  portfolio add        Add a repo to a portfolio");
  console.log("  portfolio list       List all portfolios and their repos");
  console.log("  portfolio sync       Re-sync all repos in a portfolio");
  console.log("  portfolio status     Cross-repo relationship summary");
  console.log("  portfolio init       Interactive portfolio setup\n");

  console.log("ADR WORKFLOW");
  console.log("  adr list             Pending ADR candidates from sessions");
  console.log("  adr confirm <id>     Promote a decision to accepted");
  console.log("  adr discard <id>     Archive a superseded decision");
  console.log("  adr post-pr          Post candidates as GitHub PR comments\n");

  console.log("SKILLS");
  console.log("  skills               Show skill manifest for this repo");
  console.log("  skills --onboarding  What you're missing vs the team standard");
  console.log("  skills --diff        Skill drift across repos in portfolio\n");

  console.log("IMPORTING");
  console.log("  import               Scan all docs and git history for records");
  console.log("  import --dry-run     Preview what would be imported");
  console.log("  import --file <f>    Import a single file\n");

  console.log("PERSONAL NOTES (cross-repo, injected every session)");
  console.log("  remember <text>      Store a fact Claude should always know");
  console.log("  memories             List stored notes");
  console.log("  memories --tag <t>   Filter by tag");
  console.log("  forget <id>          Delete a note by short id");
  console.log("  forget --tag <t>     Delete all notes with a tag\n");

  console.log("WORKER & SYSTEM");
  console.log("  worker start         Start the background worker (port 37778)");
  console.log("  worker stop          Stop the background worker");
  console.log("  worker status        Check worker health and uptime");
  console.log("  auth generate        Generate a per-developer auth token");
  console.log("  auth list            List active tokens");
  console.log("  auth revoke          Revoke a token\n");

  console.log("AGENTS");
  console.log("  agents list          List available specialist agents");
  console.log("  agents run <name>    Run a named agent\n");

  console.log("Run: claude-lore help <command>   for detailed help on any command");
  console.log("Run: claude-lore doctor           to verify your setup\n");
}

function printCommandHelp(commandName: string): void {
  const cmd = COMMAND_MAP.get(commandName);
  if (!cmd) {
    console.log(`Unknown command: ${commandName}. Run claude-lore help to see all commands.`);
    return;
  }

  console.log(`\nclaude-lore ${cmd.name}`);
  console.log(DIVIDER.slice(0, `claude-lore ${cmd.name}`.length + 1));
  console.log(cmd.summary);
  console.log();

  console.log("DESCRIPTION");
  // Wrap at ~72 chars
  const descWords = cmd.description.split(" ");
  let line = "  ";
  for (const word of descWords) {
    if (line.length + word.length + 1 > 74) {
      console.log(line);
      line = `  ${word}`;
    } else {
      line = line === "  " ? `  ${word}` : `${line} ${word}`;
    }
  }
  if (line.trim()) console.log(line);
  console.log();

  if (cmd.usage.length > 0) {
    console.log("USAGE");
    for (const u of cmd.usage) {
      console.log(`  ${u}`);
    }
    console.log();
  }

  if (cmd.flags.length > 0) {
    console.log("FLAGS");
    for (const f of cmd.flags) {
      const flagStr = f.short ? `${f.flag}, ${f.short}` : f.flag;
      console.log(`  ${flagStr.padEnd(24)} ${f.desc}`);
    }
    console.log();
  }

  if (cmd.examples.length > 0) {
    console.log("EXAMPLES");
    for (const e of cmd.examples) {
      console.log(`  ${e.command}`);
      console.log(`    ${e.desc}`);
      console.log();
    }
  }

  if (cmd.seeAlso.length > 0) {
    console.log("SEE ALSO");
    console.log(`  ${cmd.seeAlso.map((s) => `claude-lore ${s}`).join("  ")}`);
    console.log();
  }
}

export function runHelp(commandName?: string): void {
  if (commandName) {
    printCommandHelp(commandName);
  } else {
    printGroupedHelp();
  }
}
