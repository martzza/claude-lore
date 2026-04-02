import { execFileSync } from "child_process";

// ---------------------------------------------------------------------------
// Version check — fetches latest GitHub release, cached for 1 hour
// ---------------------------------------------------------------------------

export interface VersionCheckResult {
  current:       string;
  latest:        string | null;
  up_to_date:    boolean;
  release_url:   string | null;
  release_notes: string | null;
  checked_at:    number;
  available:     boolean;
}

const CURRENT_VERSION = "1.0.0";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let _cache: VersionCheckResult | null = null;
let _cachedAt = 0;

function getGitHubUsername(): string | null {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      timeout: 3000,
      encoding: "utf8",
    }).trim();
    // Handles:
    //   https://github.com/username/repo.git
    //   git@github.com:username/repo.git
    const httpsMatch = remote.match(/github\.com\/([^/]+)\//);
    if (httpsMatch) return httpsMatch[1] ?? null;
    const sshMatch = remote.match(/github\.com:([^/]+)\//);
    if (sshMatch) return sshMatch[1] ?? null;
  } catch { /* no git remote */ }
  return null;
}

export async function checkVersion(): Promise<VersionCheckResult> {
  const now = Date.now();
  if (_cache && now - _cachedAt < CACHE_TTL_MS) {
    return _cache;
  }

  const base: VersionCheckResult = {
    current:       CURRENT_VERSION,
    latest:        null,
    up_to_date:    true,
    release_url:   null,
    release_notes: null,
    checked_at:    now,
    available:     false,
  };

  const username = getGitHubUsername();
  if (!username) {
    _cache = base;
    _cachedAt = now;
    return base;
  }

  try {
    const resp = await fetch(
      `https://api.github.com/repos/${username}/claude-lore/releases/latest`,
      {
        headers: { "User-Agent": "claude-lore-worker/1.0" },
        signal:  AbortSignal.timeout(5000),
      },
    );
    if (!resp.ok) {
      _cache = base;
      _cachedAt = now;
      return base;
    }
    const data = (await resp.json()) as {
      tag_name?:   string;
      html_url?:   string;
      body?:       string;
    };
    const latest = (data.tag_name ?? "").replace(/^v/, "");
    const up_to_date = !latest || latest <= CURRENT_VERSION;
    const result: VersionCheckResult = {
      current:       CURRENT_VERSION,
      latest:        latest || null,
      up_to_date,
      release_url:   data.html_url ?? null,
      release_notes: data.body ? data.body.slice(0, 500) : null,
      checked_at:    now,
      available:     !!latest,
    };
    _cache = result;
    _cachedAt = now;
    return result;
  } catch {
    _cache = base;
    _cachedAt = now;
    return base;
  }
}
