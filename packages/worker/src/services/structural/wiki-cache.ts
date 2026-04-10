// Shared wiki cache — imported by both routes and watcher to avoid circular deps.

import type { WikiPage } from "./wiki.js";

interface WikiCacheEntry {
  pages:       WikiPage[];
  generatedAt: number;
}

const _cache = new Map<string, WikiCacheEntry>();

export const WIKI_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function getWikiCache(cwd: string): WikiCacheEntry | undefined {
  return _cache.get(cwd);
}

export function setWikiCache(cwd: string, pages: WikiPage[]): void {
  _cache.set(cwd, { pages, generatedAt: Date.now() });
}

export function invalidateWikiCache(cwd: string): void {
  _cache.delete(cwd);
}
