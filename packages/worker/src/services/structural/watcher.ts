import { watch, FSWatcher, existsSync, writeFileSync, chmodSync, readFileSync } from "fs";
import { join } from "path";
import { buildIndex } from "./indexer.js";
import { invalidateWikiCache } from "./wiki-cache.js";

// ─── State ────────────────────────────────────────────────────────────────────

interface WatchState {
  repo:     string;
  cwd:      string;
  watcher?: FSWatcher;
  debounce?: ReturnType<typeof setTimeout>;
  running:  boolean;
}

const watchStates = new Map<string, WatchState>();

// ─── Public API ───────────────────────────────────────────────────────────────

export async function startWatch(repo: string, cwd: string): Promise<void> {
  if (watchStates.get(repo)?.running) {
    console.log(`[claude-lore] watch already running for ${repo}`);
    return;
  }

  const state: WatchState = { repo, cwd, running: true };
  watchStates.set(repo, state);

  console.log(`[claude-lore] watching ${cwd} for changes...`);

  state.watcher = watch(cwd, { recursive: true }, (event, filename) => {
    if (!filename) return;

    // Only react to TS/JS file changes
    if (!/\.(ts|tsx|js|jsx)$/.test(filename)) return;

    // Skip node_modules, dist, .git
    if (/node_modules|\.git|dist\/|build\//.test(filename)) return;

    // Debounce — wait 300ms after last change before reindexing
    if (state.debounce) clearTimeout(state.debounce);
    state.debounce = setTimeout(async () => {
      const ts = new Date().toLocaleTimeString();
      console.log(`[claude-lore] [${ts}] ${filename} changed — updating index...`);
      try {
        const result = await buildIndex(repo, cwd);
        if (!result.skipped) {
          invalidateWikiCache(cwd);
          console.log(
            `[claude-lore]            → ${result.changed_files ?? 0} files re-parsed in ${result.duration_ms}ms` +
            (result.unchanged_files ? ` (${result.unchanged_files} skipped)` : ""),
          );
        }
      } catch (e) {
        console.error("[claude-lore] watch index error:", e);
      }
    }, 300);
  });

  await installGitHook(cwd);
}

export function stopWatch(repo: string): void {
  const state = watchStates.get(repo);
  if (!state) return;
  state.watcher?.close();
  if (state.debounce) clearTimeout(state.debounce);
  state.running = false;
  watchStates.delete(repo);
  console.log(`[claude-lore] watch stopped for ${repo}`);
}

export function isWatching(repo: string): boolean {
  return watchStates.get(repo)?.running ?? false;
}

// ─── Git hook ─────────────────────────────────────────────────────────────────

async function installGitHook(cwd: string): Promise<void> {
  const hookPath = join(cwd, ".git", "hooks", "post-commit");
  const hookContent = `#!/bin/sh\n# claude-lore: update structural index on commit\nclaude-lore index --incremental 2>/dev/null &\n`;

  try {
    if (!existsSync(join(cwd, ".git"))) return;

    if (existsSync(hookPath)) {
      const existing = readFileSync(hookPath, "utf8");
      if (existing.includes("claude-lore")) return;
      writeFileSync(hookPath, existing + "\n" + hookContent);
    } else {
      writeFileSync(hookPath, hookContent);
    }
    chmodSync(hookPath, "755");
    console.log("[claude-lore] git post-commit hook installed");
  } catch (e) {
    console.warn("[claude-lore] could not install git hook:", e);
  }
}
