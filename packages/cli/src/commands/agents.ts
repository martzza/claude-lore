import { existsSync, readdirSync, readFileSync } from "fs";
import { join, basename, extname } from "path";
import { homedir } from "os";

// Plugin agents directory — resolved relative to this file (dist-equivalent)
// Works whether running via `bun run` from repo root or installed globally.
const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;
const AGENTS_DIR = join(REPO_ROOT, "plugins", "claude-lore", "agents");

interface AgentMeta {
  id: string;
  description: string;
  file: string;
}

const AGENT_ALIASES: Record<string, string> = {
  "blast-radius": "blast-radius-checker",
  "adr-drafter": "adr-drafter",
  "handover": "session-handover",
  "session-handover": "session-handover",
  "cross-repo-validator": "cross-repo-validator",
  "cross-repo": "cross-repo-validator",
};

function parseDescription(content: string): string {
  const match = content.match(/^---[\s\S]*?description:\s*(.+?)[\n,][\s\S]*?---/m);
  if (!match) return "(no description)";
  // Handle multi-line descriptions in frontmatter (indented continuation)
  return match[1]!.replace(/\s+/g, " ").trim().replace(/^['"]|['"]$/g, "");
}

function listAgentFiles(): AgentMeta[] {
  if (!existsSync(AGENTS_DIR)) return [];
  const files = readdirSync(AGENTS_DIR).filter((f) => extname(f) === ".md");
  return files.map((f) => {
    const id = basename(f, ".md");
    const content = readFileSync(join(AGENTS_DIR, f), "utf8");
    return { id, description: parseDescription(content), file: join(AGENTS_DIR, f) };
  });
}

// ---------------------------------------------------------------------------
// agents list
// ---------------------------------------------------------------------------

export async function agentsList(): Promise<void> {
  const agents = listAgentFiles();

  if (agents.length === 0) {
    console.log("No agents found. Expected directory: " + AGENTS_DIR);
    return;
  }

  console.log("\nAvailable agents:\n");
  for (const agent of agents) {
    console.log(`  ${agent.id}`);
    console.log(`    ${agent.description.slice(0, 120)}`);
    console.log(`    Run: claude-lore agents run ${agent.id}`);
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// agents run
// ---------------------------------------------------------------------------

export async function agentsRun(
  agentName: string,
  opts: { symbol?: string },
): Promise<void> {
  const resolved = AGENT_ALIASES[agentName] ?? agentName;
  const agentFile = join(AGENTS_DIR, `${resolved}.md`);

  if (!existsSync(agentFile)) {
    console.error(`Agent not found: ${resolved}`);
    console.error(`Available agents: ${listAgentFiles().map((a) => a.id).join(", ")}`);
    process.exit(1);
  }

  let content = readFileSync(agentFile, "utf8");

  // Strip frontmatter
  content = content.replace(/^---[\s\S]*?---\n/, "").trim();

  // Inject symbol if provided (used by cross-repo-validator)
  if (opts.symbol) {
    content = content.replace(/\{symbol\}/g, opts.symbol);
  }

  // Print instructions for use
  console.log(`\n=== Agent: ${resolved} ===\n`);
  console.log("To use this agent, start a new Claude Code session and paste the");
  console.log("following system prompt, or run it as a subagent:\n");
  console.log("─".repeat(60));
  console.log(content);
  console.log("─".repeat(60));
  console.log("");
  console.log("Tip: In Claude Code you can also invoke this agent directly via:");
  console.log(`  /agent ${resolved}`);
  console.log("");
}