import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";
import { findProjectRoot, ensureWorkerRunning } from "../worker-utils.js";
import { buildClaudeMdWizard, writeClaudeMd } from "../claude-md.js";

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

const CODEGRAPH_CONFIG_TEMPLATE = {
  visibility_default: "private",
  canonical_skills: ["kg-query", "kg-doc", "review"],
};

function buildClaudeHooks(loreRoot: string): Record<string, unknown> {
  const h = (script: string) =>
    `node ${join(loreRoot, "packages/hooks/claude-code", script)}`;
  return {
    SessionStart: [{ matcher: "", hooks: [{ type: "command", command: h("context-hook.js") }] }],
    UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: h("intent-hook.js") }] }],
    PostToolUse: [{ matcher: "Edit|Write|Bash", hooks: [{ type: "command", command: h("observe-hook.js") }] }],
    Stop: [{ matcher: "", hooks: [{ type: "command", command: h("summary-hook.js") }] }],
    SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: h("cleanup-hook.js") }] }],
  };
}

function buildCursorHooks(loreRoot: string): Record<string, unknown> {
  const h = (script: string) =>
    `node ${join(loreRoot, "packages/hooks/cursor", script)}`;
  return {
    hooks: {
      beforeSubmitPrompt: { command: h("context-hook.js"), timeout: 5000 },
      afterFileEdit: { command: h("observe-hook.js"), timeout: 3000 },
      beforeShellExecution: { command: h("shell-hook.js"), timeout: 3000 },
      stop: { command: h("summary-hook.js"), timeout: 5000 },
    },
  };
}

function mergeSettings(settingsPath: string, newHooks: Record<string, unknown>): void {
  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {}
  }
  const merged = {
    ...existing,
    hooks: {
      ...((existing.hooks as Record<string, unknown>) ?? {}),
      ...newHooks,
    },
  };
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
}

function mergeCursorHooks(hooksPath: string, newConfig: Record<string, unknown>): void {
  let existing: Record<string, unknown> = {};
  if (existsSync(hooksPath)) {
    try {
      existing = JSON.parse(readFileSync(hooksPath, "utf8")) as Record<string, unknown>;
    } catch {}
  }
  const merged = {
    ...existing,
    hooks: {
      ...((existing.hooks as Record<string, unknown>) ?? {}),
      ...((newConfig.hooks as Record<string, unknown>) ?? {}),
    },
  };
  writeFileSync(hooksPath, JSON.stringify(merged, null, 2));
}

function isFirstSetup(globalConfigPath: string): boolean {
  if (!existsSync(globalConfigPath)) return true;
  try {
    const cfg = JSON.parse(readFileSync(globalConfigPath, "utf8")) as Record<string, unknown>;
    return cfg["mode"] === undefined;
  } catch {
    return true;
  }
}

function writeGlobalField(globalConfigPath: string, fields: Record<string, unknown>): void {
  let cfg: Record<string, unknown> = {};
  if (existsSync(globalConfigPath)) {
    try {
      cfg = JSON.parse(readFileSync(globalConfigPath, "utf8")) as Record<string, unknown>;
    } catch {}
  }
  Object.assign(cfg, fields);
  mkdirSync(join(homedir(), ".codegraph"), { recursive: true });
  writeFileSync(globalConfigPath, JSON.stringify(cfg, null, 2));
}

export async function runInit(repoPath: string): Promise<void> {
  const loreRoot = findProjectRoot();

  // ── Step 1: .codegraph/ ──────────────────────────────────────────────────
  const codegraphDir = join(repoPath, ".codegraph");
  if (existsSync(codegraphDir)) {
    console.log("✓ .codegraph/ already exists");
  } else {
    mkdirSync(join(codegraphDir, "templates"), { recursive: true });
    writeFileSync(
      join(codegraphDir, "config.json"),
      JSON.stringify(CODEGRAPH_CONFIG_TEMPLATE, null, 2)
    );
    writeFileSync(
      join(codegraphDir, "exports.manifest"),
      JSON.stringify({ exports: [] }, null, 2)
    );
    console.log("✓ Created .codegraph/");
    console.log("✓ Created .codegraph/config.json");
  }

  // ── Step 2: Worker ───────────────────────────────────────────────────────
  process.stdout.write("⟳ Starting worker...\r");
  const { alreadyRunning, healthy } = await ensureWorkerRunning(loreRoot);
  if (!healthy) {
    console.error("✗ Worker failed to start — check ~/.codegraph/worker-error.log");
    process.exit(1);
  }
  if (alreadyRunning) {
    console.log("✓ Worker already running on http://127.0.0.1:37778");
  } else {
    console.log("✓ Worker running on http://127.0.0.1:37778");
  }

  // ── Step 3: .claude/settings.json ───────────────────────────────────────
  const claudeDir = join(repoPath, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.json");
  mergeSettings(settingsPath, buildClaudeHooks(loreRoot));
  console.log("✓ Registered in .claude/settings.json");

  // ── Step 3b: ~/.claude/commands/lore.md ─────────────────────────────────
  const globalCommandsDir = join(homedir(), ".claude", "commands");
  mkdirSync(globalCommandsDir, { recursive: true });
  const loreCommandSrc = join(loreRoot, "plugins", "claude-lore", "commands", "lore.md");
  const loreCommandDst = join(globalCommandsDir, "lore.md");
  if (existsSync(loreCommandSrc)) {
    copyFileSync(loreCommandSrc, loreCommandDst);
    console.log("✓ Installed /lore command to ~/.claude/commands/lore.md");
  }

  // ── Step 3c: ~/.claude/settings.json — MCP server (global) ─────────────
  // The plugin .mcp.json uses ${CLAUDE_PLUGIN_ROOT} which only resolves via
  // the plugin marketplace. For git-clone installs, register the MCP server
  // explicitly so /lore MCP tool calls work from day one.
  const globalClaudeSettingsPath = join(homedir(), ".claude", "settings.json");
  const mcpEntry = {
    "claude-lore": {
      command: "bun",
      args: ["run", join(loreRoot, "packages/worker/mcp.ts")],
      env: { CLAUDE_LORE_PORT: "37778" },
    },
  };
  let globalClaudeSettings: Record<string, unknown> = {};
  if (existsSync(globalClaudeSettingsPath)) {
    try {
      globalClaudeSettings = JSON.parse(readFileSync(globalClaudeSettingsPath, "utf8")) as Record<string, unknown>;
    } catch {}
  }
  const existingMcpServers = (globalClaudeSettings["mcpServers"] as Record<string, unknown>) ?? {};
  globalClaudeSettings["mcpServers"] = { ...existingMcpServers, ...mcpEntry };
  writeFileSync(globalClaudeSettingsPath, JSON.stringify(globalClaudeSettings, null, 2));
  console.log("✓ Registered MCP server in ~/.claude/settings.json");

  // ── Step 3c: .cursor/ (only if it already exists) ───────────────────────
  const cursorDir = join(repoPath, ".cursor");
  if (existsSync(cursorDir)) {
    const cursorHooksPath = join(cursorDir, "hooks.json");
    mergeCursorHooks(cursorHooksPath, buildCursorHooks(loreRoot));
    console.log("✓ Registered in .cursor/hooks.json");

    const mcpPath = join(cursorDir, "mcp.json");
    let existingMcp: Record<string, unknown> = {};
    if (existsSync(mcpPath)) {
      try {
        existingMcp = JSON.parse(readFileSync(mcpPath, "utf8")) as Record<string, unknown>;
      } catch {}
    }
    const mcpServers = ((existingMcp.mcpServers as Record<string, unknown>) ?? {});
    const mergedMcp = {
      ...existingMcp,
      mcpServers: {
        ...mcpServers,
        "claude-lore": {
          command: "bun",
          args: ["run", join(loreRoot, "packages/worker/mcp.ts")],
          env: { CLAUDE_LORE_PORT: "37778" },
        },
      },
    };
    writeFileSync(mcpPath, JSON.stringify(mergedMcp, null, 2));
  }

  // ── Step 4: Mode + Team sync ─────────────────────────────────────────────
  const globalConfigPath = join(homedir(), ".codegraph", "config.json");
  const firstSetup = isFirstSetup(globalConfigPath);

  const tursoAlreadyConfigured = (() => {
    if (!existsSync(globalConfigPath)) return false;
    try {
      const cfg = JSON.parse(readFileSync(globalConfigPath, "utf8")) as Record<string, unknown>;
      return typeof cfg["turso_url"] === "string" && (cfg["turso_url"] as string).length > 0;
    } catch { return false; }
  })();

  if (tursoAlreadyConfigured) {
    console.log("✓ Turso team sync already configured");
    // Ensure mode is written if this is a first-setup-after-upgrade scenario
    if (firstSetup) {
      writeGlobalField(globalConfigPath, { mode: "team" });
      console.log("✓ Mode set to: team");
    }
  } else if (firstSetup) {
    // First time on this machine — offer quickstart vs full setup
    console.log();
    console.log("─────────────────────────────────────────────────────────");
    console.log("  Welcome to claude-lore");
    console.log("─────────────────────────────────────────────────────────");
    console.log("  Quick setup  — solo mode, local-only, running in ~2 min");
    console.log("  Full setup   — team mode, Turso sync, auth tokens\n");

    const setupAnswer = await prompt("  Quick or full setup? [quick/full] (default: quick): ");
    const doFull = setupAnswer.toLowerCase() === "full";

    if (!doFull) {
      // ── Quickstart path ────────────────────────────────────────────────
      writeGlobalField(globalConfigPath, { mode: "solo" });
      console.log("\n  ✓ Mode set to: solo");
      console.log("  Solo mode: local-only, no auth required, no team sync.");
      console.log("  Upgrade later: claude-lore mode set team\n");
    } else {
      // ── Full setup path ────────────────────────────────────────────────
      console.log();
      console.log("  Create a free database at https://turso.tech if you don't have one yet.");
      console.log("  Then run: turso db show <name> --url  and  turso db tokens create <name>\n");

      const tursoUrl = await prompt("  Turso database URL (libsql://...): ");
      const tursoToken = await prompt("  Auth token: ");

      if (tursoUrl.startsWith("libsql://") && tursoToken.length > 0) {
        writeGlobalField(globalConfigPath, {
          mode: "team",
          turso_url: tursoUrl,
          turso_auth_token: tursoToken,
        });
        console.log("\n  ✓ Turso team sync configured (~/.codegraph/config.json)");
        console.log("  ✓ Mode set to: team");
        console.log("  Restart the worker to activate:  claude-lore worker restart");
      } else {
        console.log("\n  Skipped — URL must start with libsql:// and token must not be empty.");
        console.log("  Defaulting to solo mode. Configure team sync later:");
        console.log("    claude-lore mode set team");
        writeGlobalField(globalConfigPath, { mode: "solo" });
      }
    }
  } else {
    // Returning user without Turso — show non-intrusive reminder
    console.log("  (No team sync — run 'claude-lore mode set team' to configure)");
  }

  // ── Step 5: CLAUDE.md ───────────────────────────────────────────────────
  const claudeMdPath = join(repoPath, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    console.log();
    console.log("  No CLAUDE.md found in this repo.");
    console.log("  CLAUDE.md tells Claude about your project conventions and is loaded on every prompt.");
    const createIt = await prompt("  Build a CLAUDE.md now? [Y/n]: ");
    if (createIt.toLowerCase() !== "n") {
      const claudeMdContent = await buildClaudeMdWizard(repoPath, prompt);
      if (claudeMdContent) writeClaudeMd(claudeMdPath, claudeMdContent);
    }
  } else {
    console.log("✓ CLAUDE.md exists");
  }

  // ── Step 6: Verification checklist ──────────────────────────────────────
  console.log();
  console.log("Setup verification");
  console.log("──────────────────");

  const checks: Array<{ label: string; ok: boolean; fix?: string }> = [
    {
      label: ".codegraph/config.json",
      ok: existsSync(join(repoPath, ".codegraph", "config.json")),
      fix: "re-run: claude-lore init",
    },
    {
      label: ".claude/settings.json (hooks)",
      ok: (() => {
        const p = join(repoPath, ".claude", "settings.json");
        if (!existsSync(p)) return false;
        try {
          const s = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
          return typeof s["hooks"] === "object" && s["hooks"] !== null;
        } catch { return false; }
      })(),
      fix: "re-run: claude-lore init",
    },
    {
      label: "Hook scripts (context-hook.js)",
      ok: existsSync(join(loreRoot, "packages", "hooks", "claude-code", "context-hook.js")),
      fix: "run: pnpm install from the claude-lore directory",
    },
    {
      label: "~/.claude/commands/lore.md",
      ok: existsSync(join(homedir(), ".claude", "commands", "lore.md")),
      fix: "re-run: claude-lore init",
    },
    {
      label: "~/.claude/settings.json (MCP server)",
      ok: (() => {
        const p = join(homedir(), ".claude", "settings.json");
        if (!existsSync(p)) return false;
        try {
          const s = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
          const mcp = s["mcpServers"] as Record<string, unknown> | undefined;
          return typeof mcp === "object" && mcp !== null && "claude-lore" in mcp;
        } catch { return false; }
      })(),
      fix: "re-run: claude-lore init",
    },
    {
      label: "~/.codegraph/config.json (mode)",
      ok: (() => {
        const p = join(homedir(), ".codegraph", "config.json");
        if (!existsSync(p)) return false;
        try {
          const c = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
          return typeof c["mode"] === "string";
        } catch { return false; }
      })(),
      fix: "re-run: claude-lore init",
    },
    {
      label: "Worker (port 37778)",
      ok: await (async () => {
        try {
          const r = await fetch("http://127.0.0.1:37778/health", { signal: AbortSignal.timeout(2000) });
          return r.ok;
        } catch { return false; }
      })(),
      fix: "run: claude-lore worker start",
    },
    {
      label: "CLAUDE.md",
      ok: existsSync(join(repoPath, "CLAUDE.md")),
      fix: "re-run: claude-lore init  (will offer to create one)",
    },
  ];

  let allOk = true;
  for (const check of checks) {
    if (check.ok) {
      console.log(`  ✓  ${check.label}`);
    } else {
      console.log(`  ✗  ${check.label}`);
      if (check.fix) console.log(`       → ${check.fix}`);
      allOk = false;
    }
  }

  // ── Step 7: Next steps ───────────────────────────────────────────────────
  console.log();
  if (allOk) {
    console.log(`✓ claude-lore fully initialised in ${repoPath}`);
    console.log();
    console.log("Run next:");
    console.log("  claude-lore bootstrap");
    console.log();
    console.log("Store a persistent note:");
    console.log('  claude-lore remember "<anything claude should always know>"');
  } else {
    console.log("✗ Some checks failed — fix the issues above and re-run: claude-lore init");
  }
}
