import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { findProjectRoot, ensureWorkerRunning } from "../worker-utils.js";

const CODEGRAPH_CONFIG_TEMPLATE = {
  visibility_default: "private",
  canonical_skills: ["kg-query", "kg-doc"],
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

  // ── Step 3b: .cursor/ (only if it already exists) ───────────────────────
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

  // ── Step 4: Next steps ───────────────────────────────────────────────────
  console.log();
  console.log(`✓ claude-lore initialised in ${repoPath}`);
  console.log();
  console.log("Run next:");
  console.log("  claude-lore bootstrap");
}
