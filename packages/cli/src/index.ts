#!/usr/bin/env bun
import { Command } from "commander";

const program = new Command();

program
  .name("claude-lore")
  .description("Structural + reasoning knowledge graph for AI coding agents")
  .version("0.1.0");

// claude-lore init
program
  .command("init")
  .description("Initialise a repo for claude-lore")
  .option("--repo <path>", "Path to repo (defaults to cwd)", process.cwd())
  .action(async (opts: { repo: string }) => {
    const { runInit } = await import("./commands/init.js");
    await runInit(opts.repo);
  });

// claude-lore bootstrap
program
  .command("bootstrap")
  .description("Run the bootstrap wizard to pre-populate the reasoning layer")
  .option("--framework <name>", "Use a specific template (e.g. owasp-top10)")
  .option("--all", "Run all non-hidden templates without selection prompt")
  .option("--yes, -y", "Skip confirmation prompt and write immediately")
  .option("--dry-run", "Preview records without writing")
  .option("--list", "List available templates")
  .action(async (opts: { framework?: string; all?: boolean; yes?: boolean; dryRun?: boolean; list?: boolean }) => {
    const { runBootstrap } = await import("./commands/bootstrap.js");
    await runBootstrap(opts);
  });

// claude-lore graph
const graphCmd = program.command("graph").description("Generate visual knowledge graphs");

graphCmd
  .command("decisions")
  .description("Decision hierarchy graph")
  .option("--format <fmt>", "Output format: mermaid|dot|html|json", "mermaid")
  .option("--open", "Write HTML to /tmp and open in browser")
  .option("--repo <path>", "Repo path (defaults to cwd)")
  .action(async (opts: { format?: string; open?: boolean; repo?: string }) => {
    const { graphDecisions } = await import("./commands/graph.js");
    await graphDecisions(opts);
  });

graphCmd
  .command("symbol <symbol>")
  .description("Symbol impact graph")
  .option("--format <fmt>", "Output format: mermaid|dot|html|json", "mermaid")
  .option("--open", "Write HTML to /tmp and open in browser")
  .option("--repo <path>", "Repo path (defaults to cwd)")
  .action(async (symbol: string, opts: { format?: string; open?: boolean; repo?: string }) => {
    const { graphSymbol } = await import("./commands/graph.js");
    await graphSymbol(symbol, opts);
  });

graphCmd
  .command("portfolio")
  .description("Cross-repo dependency map")
  .option("--format <fmt>", "Output format: mermaid|dot|html|json", "mermaid")
  .option("--open", "Write HTML to /tmp and open in browser")
  .option("--repos <list>", "Comma-separated repo paths (defaults to all)")
  .action(async (opts: { format?: string; open?: boolean; repos?: string }) => {
    const { graphPortfolio } = await import("./commands/graph.js");
    await graphPortfolio(opts);
  });

// claude-lore portfolio
const portfolioCmd = program.command("portfolio").description("Manage cross-repo portfolio links");

portfolioCmd
  .command("create <name>")
  .description("Create a new named portfolio")
  .option("--description <desc>", "Optional description")
  .action(async (name: string, opts: { description?: string }) => {
    const { portfolioCreate } = await import("./commands/portfolio.js");
    await portfolioCreate(name, opts);
  });

portfolioCmd
  .command("add <name> <repo-path>")
  .description("Add a repo to a portfolio and sync its manifest")
  .action(async (name: string, repoPath: string) => {
    const { portfolioAdd } = await import("./commands/portfolio.js");
    await portfolioAdd(name, repoPath);
  });

portfolioCmd
  .command("remove <name> <repo-path>")
  .description("Remove a repo from a portfolio")
  .action(async (name: string, repoPath: string) => {
    const { portfolioRemove } = await import("./commands/portfolio.js");
    await portfolioRemove(name, repoPath);
  });

portfolioCmd
  .command("list")
  .description("List all portfolios and their repos")
  .action(async () => {
    const { portfolioList } = await import("./commands/portfolio.js");
    await portfolioList();
  });

portfolioCmd
  .command("sync <name>")
  .description("Re-sync all repos in a portfolio to the registry")
  .action(async (name: string) => {
    const { portfolioSync } = await import("./commands/portfolio.js");
    await portfolioSync(name);
  });

portfolioCmd
  .command("status <name>")
  .description("Show cross-repo relationship summary for a portfolio")
  .action(async (name: string) => {
    const { portfolioStatus } = await import("./commands/portfolio.js");
    await portfolioStatus(name);
  });

portfolioCmd
  .command("init <name>")
  .description("Interactively create a portfolio and link repos")
  .action(async (name: string) => {
    const { portfolioInit } = await import("./commands/portfolio.js");
    await portfolioInit(name);
  });

// claude-lore import
program
  .command("import")
  .description("Discover and import documentation from markdown files")
  .option("--dry-run", "Preview records without writing")
  .option("--path <dir>", "Scan a specific subdirectory")
  .option("--file <file>", "Import a single markdown file")
  .action(async (opts: { dryRun?: boolean; path?: string; file?: string }) => {
    const { runImportCommand } = await import("./commands/import.js");
    await runImportCommand(opts);
  });

// claude-lore worker
const workerCmd = program.command("worker").description("Manage the claude-lore background worker");

workerCmd
  .command("start")
  .description("Start the worker via PM2")
  .action(async () => {
    const { workerStart } = await import("./commands/worker.js");
    await workerStart();
  });

workerCmd
  .command("stop")
  .description("Stop the worker via PM2")
  .action(async () => {
    const { workerStop } = await import("./commands/worker.js");
    await workerStop();
  });

workerCmd
  .command("status")
  .description("Show worker status via PM2")
  .action(async () => {
    const { workerStatus } = await import("./commands/worker.js");
    await workerStatus();
  });

// claude-lore skills
program
  .command("skills")
  .description("Show skill manifest")
  .option("--diff", "Show skill drift across repos")
  .action(async (opts: { diff?: boolean }) => {
    const { runSkills } = await import("./commands/skills.js");
    await runSkills(opts);
  });

// claude-lore review
program
  .command("review")
  .description("Review pending extracted records and promote to confirmed")
  .action(async () => {
    const { runReview } = await import("./commands/review.js");
    await runReview();
  });

// claude-lore auth
const authCmd = program.command("auth").description("Manage developer auth tokens");
authCmd
  .command("generate <author>")
  .description("Generate a new auth token for an author")
  .option("--scopes <scopes>", "Comma-separated scopes", "read,write:sessions,write:decisions")
  .action(async (author: string, opts: { scopes: string }) => {
    const { runAuthGenerate } = await import("./commands/auth.js");
    await runAuthGenerate(author, opts.scopes.split(","));
  });
authCmd
  .command("list")
  .description("List all tokens (masked)")
  .action(async () => {
    const { runAuthList } = await import("./commands/auth.js");
    await runAuthList();
  });
authCmd
  .command("revoke <token>")
  .description("Revoke a token")
  .action(async (token: string) => {
    const { runAuthRevoke } = await import("./commands/auth.js");
    await runAuthRevoke(token);
  });

// claude-lore adr
const adrCmd = program.command("adr").description("ADR review flow");
adrCmd
  .command("list")
  .description("List pending ADR candidates for current repo")
  .action(async () => {
    const { adrList } = await import("./commands/adr.js");
    await adrList();
  });
adrCmd
  .command("confirm <id>")
  .description("Accept an ADR candidate (sets accepted + confirmed)")
  .action(async (id: string) => {
    const { adrConfirm } = await import("./commands/adr.js");
    await adrConfirm(id);
  });
adrCmd
  .command("discard <id>")
  .description("Archive an ADR candidate (sets superseded)")
  .action(async (id: string) => {
    const { adrDiscard } = await import("./commands/adr.js");
    await adrDiscard(id);
  });
adrCmd
  .command("post-pr")
  .description("Post all ADR candidates as PR comments via gh CLI")
  .action(async () => {
    const { adrPostPr } = await import("./commands/adr.js");
    await adrPostPr();
  });

// claude-lore manifest
const manifestCmd = program.command("manifest").description("Manifest and tier management");
manifestCmd
  .command("infer")
  .description("Show suggested visibility tier changes for symbols in current repo")
  .option("--apply", "Apply suggested changes (Phase 5)")
  .action(async (opts: { apply?: boolean }) => {
    const { runManifestInfer } = await import("./commands/manifest-cmd.js");
    await runManifestInfer(opts);
  });

// claude-lore advisor
const advisorCmd = program
  .command("advisor")
  .description("Proactive advisor — surface knowledge gaps, CLAUDE.md issues, and skill gaps")
  .action(async () => {
    const { advisorSummary } = await import("./commands/advisor.js");
    await advisorSummary();
  });

advisorCmd
  .command("gaps")
  .description("Show knowledge gaps in the reasoning layer (missing ADRs, orphaned records, stale work)")
  .action(async () => {
    const { advisorGaps } = await import("./commands/advisor.js");
    await advisorGaps();
  });

advisorCmd
  .command("claudemd")
  .description("Analyse CLAUDE.md for redundancies, missing sections, and token bloat")
  .option("--apply", "Apply safe fixes (currently prints suggestions only)")
  .action(async (opts: { apply?: boolean }) => {
    const { advisorClaudeMd } = await import("./commands/advisor.js");
    await advisorClaudeMd(opts);
  });

advisorCmd
  .command("skills")
  .description("Suggest new skills based on repeated session patterns")
  .option("--days <n>", "Lookback window in days", "30")
  .option("--generate <name>", "Generate a skill stub file for the named suggestion")
  .action(async (opts: { days?: string; generate?: string }) => {
    const { advisorSkills } = await import("./commands/advisor.js");
    await advisorSkills({ days: opts.days ? parseInt(opts.days, 10) : 30, generate: opts.generate });
  });

advisorCmd
  .command("parallel")
  .description("Analyse deferred items (or given tasks) for parallelism opportunities")
  .option("--tasks <list>", "Comma-separated list of task descriptions to analyse")
  .option("--from-deferred", "Read open deferred items from DB (default)")
  .action(async (opts: { tasks?: string; fromDeferred?: boolean }) => {
    const { advisorParallel } = await import("./commands/advisor.js");
    await advisorParallel(opts);
  });

advisorCmd
  .command("workflow")
  .description("Analyse session history patterns and surface workflow recommendations")
  .option("--days <n>", "Lookback window in days", "60")
  .action(async (opts: { days?: string }) => {
    const { advisorWorkflow } = await import("./commands/advisor.js");
    await advisorWorkflow({ days: opts.days ? parseInt(opts.days, 10) : 60 });
  });

// claude-lore annotate
program
  .command("annotate <file_path>")
  .description("Open an annotated HTML view of a source file showing reasoning records inline")
  .option("--format <fmt>", "Output format: html (default, opens browser)|text|json", "html")
  .option("--repo <path>", "Repo path for record lookup (defaults to cwd)")
  .action(async (filePath: string, opts: { format?: string; repo?: string }) => {
    const { runAnnotate } = await import("./commands/annotate.js");
    await runAnnotate(filePath, opts);
  });

// claude-lore provenance
program
  .command("provenance <symbol>")
  .description("Print the provenance trace for a symbol — full chronological decision history")
  .option("--format <fmt>", "Output format: text (default)|html|mermaid|json")
  .option("--open", "Write HTML to /tmp and open in browser")
  .option("--repo <path>", "Repo path (defaults to cwd)")
  .action(async (symbol: string, opts: { format?: string; open?: boolean; repo?: string }) => {
    const { runProvenance } = await import("./commands/annotate.js");
    await runProvenance(symbol, opts);
  });

// claude-lore coverage
program
  .command("coverage")
  .description("Show annotation coverage — which symbols have reasoning records, which don't")
  .option("--repo <path>", "Repo path (defaults to cwd)")
  .option("--cwd <dir>", "Directory to scan for source files (defaults to repo)")
  .action(async (opts: { repo?: string; cwd?: string }) => {
    const { runCoverage } = await import("./commands/annotate.js");
    await runCoverage(opts);
  });

// claude-lore agents
const agentsCmd = program.command("agents").description("Manage and run specialist claude-lore agents");

agentsCmd
  .command("list")
  .description("List available agents")
  .action(async () => {
    const { agentsList } = await import("./commands/agents.js");
    await agentsList();
  });

agentsCmd
  .command("run <agent>")
  .description("Print the system prompt for a named agent (blast-radius, adr-drafter, handover, cross-repo-validator)")
  .option("--symbol <name>", "Symbol name (used by cross-repo-validator)")
  .action(async (agent: string, opts: { symbol?: string }) => {
    const { agentsRun } = await import("./commands/agents.js");
    await agentsRun(agent, opts);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
