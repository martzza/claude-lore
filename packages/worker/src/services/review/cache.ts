import { statSync } from "fs";
import { join } from "path";
import type { DepGraph } from "./deps.js";

// ---------------------------------------------------------------------------
// Simple mtime-based cache for dep graphs
// ---------------------------------------------------------------------------

interface CacheEntry {
  graph: DepGraph;
  built_at: number;   // Date.now() when built
  cwd: string;
}

const cache = new Map<string, CacheEntry>();

const MAX_AGE_MS = 60_000; // 1 minute — short because source changes frequently

/**
 * Return a cache key for a given cwd.
 */
function cacheKey(cwd: string): string {
  return cwd;
}

/**
 * Check whether any source file in cwd has been modified since built_at.
 * Only samples the top-level mtime of key dirs to keep it fast.
 */
function isStaleMtime(cwd: string, builtAt: number): boolean {
  // Check age first — always invalidate after MAX_AGE_MS
  if (Date.now() - builtAt > MAX_AGE_MS) return true;

  // Spot-check a few key paths
  const spots = [
    join(cwd, "src"),
    join(cwd, "packages"),
    cwd,
  ];

  for (const path of spots) {
    try {
      const st = statSync(path);
      if (st.mtimeMs > builtAt) return true;
    } catch {
      // path doesn't exist — ignore
    }
  }

  return false;
}

export function getCachedGraph(cwd: string): DepGraph | null {
  const key = cacheKey(cwd);
  const entry = cache.get(key);
  if (!entry) return null;
  if (isStaleMtime(cwd, entry.built_at)) {
    cache.delete(key);
    return null;
  }
  return entry.graph;
}

export function setCachedGraph(cwd: string, graph: DepGraph): void {
  cache.set(cacheKey(cwd), {
    graph,
    built_at: Date.now(),
    cwd,
  });
}

export function invalidateCache(cwd: string): void {
  cache.delete(cacheKey(cwd));
}

export function invalidateAll(): void {
  cache.clear();
}
