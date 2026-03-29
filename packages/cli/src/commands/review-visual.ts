import { execSync } from "child_process";

const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function assertWorkerRunning(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error();
  } catch {
    console.error("Worker not running. Start it with: claude-lore worker start");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// review-map
// ---------------------------------------------------------------------------

export async function runReviewMap(opts: {
  format?: string;
  layout?: string;
  open?: boolean;
  repo?: string;
  cwd?: string;
}): Promise<void> {
  const repo = opts.repo ?? process.cwd();
  const cwd = opts.cwd ?? repo;
  const format = opts.format ?? "html";
  const layout = opts.layout ?? "force";

  await assertWorkerRunning();

  const params = new URLSearchParams({
    repo,
    cwd,
    format,
    layout,
  });

  const res = await fetch(`${BASE_URL}/api/review/map?${params.toString()}`);

  if (!res.ok) {
    const err = await res.text();
    console.error("Error:", err);
    process.exit(1);
  }

  if (format === "mermaid") {
    const text = await res.text();
    console.log(text);
    return;
  }

  if (format === "html") {
    // Get the HTML and write to /tmp, then open
    const html = await res.text();
    const { writeFileSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const outPath = join(tmpdir(), "claude-lore-map.html");
    writeFileSync(outPath, html, "utf8");

    console.log(`Codebase map written to: ${outPath}`);

    if (opts.open !== false) {
      try {
        execSync(`open "${outPath}"`, { stdio: "ignore" });
      } catch {
        console.log("Open in browser manually.");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// review-diff
// ---------------------------------------------------------------------------

export async function runReviewDiff(opts: {
  format?: string;
  base?: string;
  open?: boolean;
  repo?: string;
  cwd?: string;
}): Promise<void> {
  const repo = opts.repo ?? process.cwd();
  const cwd = opts.cwd ?? repo;
  const format = opts.format ?? "html";
  const base = opts.base ?? "HEAD";

  await assertWorkerRunning();

  const params = new URLSearchParams({ repo, cwd, format, base });
  const res = await fetch(`${BASE_URL}/api/review/diff?${params.toString()}`);

  if (!res.ok) {
    const err = await res.text();
    console.error("Error:", err);
    process.exit(1);
  }

  if (format === "json") {
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const html = await res.text();
  const { writeFileSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const outPath = join(tmpdir(), "claude-lore-review.html");
  writeFileSync(outPath, html, "utf8");

  console.log(`Pre-commit review written to: ${outPath}`);

  if (opts.open !== false) {
    try {
      execSync(`open "${outPath}"`, { stdio: "ignore" });
    } catch {
      console.log("Open in browser manually.");
    }
  }
}

// ---------------------------------------------------------------------------
// review-propagation
// ---------------------------------------------------------------------------

export async function runReviewPropagation(
  file: string,
  opts: {
    format?: string;
    open?: boolean;
    repo?: string;
    cwd?: string;
  },
): Promise<void> {
  const repo = opts.repo ?? process.cwd();
  const cwd = opts.cwd ?? repo;
  const format = opts.format ?? "html";

  await assertWorkerRunning();

  const params = new URLSearchParams({ repo, cwd, file, format });
  const res = await fetch(`${BASE_URL}/api/review/propagation?${params.toString()}`);

  if (!res.ok) {
    const err = await res.text();
    console.error("Error:", err);
    process.exit(1);
  }

  if (format === "json") {
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const html = await res.text();
  const { writeFileSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const outPath = join(tmpdir(), "claude-lore-propagation.html");
  writeFileSync(outPath, html, "utf8");

  console.log(`Propagation view written to: ${outPath}`);

  if (opts.open !== false) {
    try {
      execSync(`open "${outPath}"`, { stdio: "ignore" });
    } catch {
      console.log("Open in browser manually.");
    }
  }
}
