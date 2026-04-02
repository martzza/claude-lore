// Shared CLAUDE.md detection and interactive wizard.
// Used by both `init` and `audit`.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface PkgInfo {
  name: string;
  description: string;
  packageManager: string;
  testRunner: string;
  hasTypeScript: boolean;
}

export function detectPkgInfo(repoPath: string): PkgInfo {
  const defaults: PkgInfo = {
    name: repoPath.split("/").pop() ?? "this project",
    description: "",
    packageManager: "npm",
    testRunner: "",
    hasTypeScript: false,
  };

  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) defaults.packageManager = "pnpm";
  else if (existsSync(join(repoPath, "yarn.lock"))) defaults.packageManager = "yarn";
  else if (existsSync(join(repoPath, "bun.lockb")) || existsSync(join(repoPath, "bun.lock"))) defaults.packageManager = "bun";

  const pkgPath = join(repoPath, "package.json");
  if (!existsSync(pkgPath)) return defaults;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    if (typeof pkg["name"] === "string") defaults.name = pkg["name"] as string;
    if (typeof pkg["description"] === "string") defaults.description = pkg["description"] as string;

    const allDeps: Record<string, string> = {
      ...((pkg["dependencies"] as Record<string, string>) ?? {}),
      ...((pkg["devDependencies"] as Record<string, string>) ?? {}),
    };

    if ("typescript" in allDeps) defaults.hasTypeScript = true;

    const testRunners = ["jest", "vitest", "mocha", "jasmine", "ava", "tap"];
    for (const t of testRunners) {
      if (t in allDeps) { defaults.testRunner = t; break; }
    }
  } catch {}

  return defaults;
}

// auditHints: short strings derived from verified audit records to surface as
// additional convention suggestions (e.g. "sessions use JWT", "auth uses bcrypt").
export async function buildClaudeMdWizard(
  repoPath: string,
  promptFn: (q: string) => Promise<string>,
  auditHints: string[] = [],
): Promise<string | null> {
  const pkg = detectPkgInfo(repoPath);

  console.log();
  console.log("  Let's build your CLAUDE.md together.");
  console.log("  Press Enter to accept suggestions, or type your own answer.");
  console.log();

  // Q1: What does this project do?
  const descSuggestion = pkg.description ? ` (detected: "${pkg.description}")` : "";
  console.log(`  What does this project do?${descSuggestion}`);
  const rawDesc = await promptFn("  > ");
  const description = rawDesc || pkg.description || "";

  // Q2: Conventions — seeded from package detection + audit-verified records
  const conventionSuggestions: string[] = [];
  if (pkg.packageManager !== "npm") conventionSuggestions.push(`always use ${pkg.packageManager} over npm`);
  if (pkg.hasTypeScript) conventionSuggestions.push("TypeScript strict mode throughout, no `any`");
  if (pkg.testRunner) conventionSuggestions.push(`use ${pkg.testRunner} for all tests`);

  console.log();
  console.log("  Key conventions Claude should always follow.");
  if (conventionSuggestions.length > 0 || auditHints.length > 0) {
    console.log("  Detected suggestions:");
    for (const s of conventionSuggestions) console.log(`    - ${s}`);
    if (auditHints.length > 0) {
      console.log("  From audit-verified records:");
      for (const h of auditHints) console.log(`    - ${h}`);
    }
  }
  console.log("  Add more (comma-separated), or press Enter to use suggestions only:");
  const rawConventions = await promptFn("  > ");

  const extraConventions = rawConventions.split(",").map((s) => s.trim()).filter(Boolean);
  const allConventions = [...conventionSuggestions, ...auditHints, ...extraConventions];

  // Q3: What to avoid
  console.log();
  console.log("  Anything Claude should never do in this repo?");
  console.log("  e.g. never use a specific library, avoid certain patterns");
  console.log("  (comma-separated, or press Enter to skip):");
  const rawAvoid = await promptFn("  > ");
  const avoidItems = rawAvoid.split(",").map((s) => s.trim()).filter(Boolean);

  // Q4: Anything else
  console.log();
  console.log("  Anything else Claude should know? e.g. external services, auth patterns,");
  console.log("  deployment targets, team norms (comma-separated, or press Enter to skip):");
  const rawExtra = await promptFn("  > ");
  const extraItems = rawExtra.split(",").map((s) => s.trim()).filter(Boolean);

  // Build content
  const conventionLines = allConventions.length > 0
    ? allConventions.map((c) => `- ${c}`).join("\n")
    : "- [add conventions here]";

  let content = `# ${pkg.name}\n`;
  content += `\n## What this codebase does\n\n`;
  content += description ? `${description}\n` : `[describe what this project does]\n`;
  content += `\n## Key conventions\n\n${conventionLines}\n`;

  if (avoidItems.length > 0) {
    content += `\n## What to avoid\n\n${avoidItems.map((a) => `- ${a}`).join("\n")}\n`;
  }

  if (extraItems.length > 0) {
    content += `\n## Additional context\n\n${extraItems.map((e) => `- ${e}`).join("\n")}\n`;
  }

  content += `
## claude-lore

This repo uses claude-lore for persistent agent memory. Decisions, risks, and
deferred work are stored in the knowledge graph and injected at session start.

- \`/lore <question>\` — query decisions, risks, deferred work, session history
- \`/lore save <text>\` — record a decision or risk inline
- \`/lore review\` — confirm or discard extracted records
- \`/lore audit\` — review gap records from the last audit run
- \`claude-lore review\` — CLI review of pending records
- \`claude-lore audit --grep-only\` — verify bootstrap accuracy against code

Keep this file lean — every token here is loaded on every prompt.
Anything already captured in the knowledge graph does not need to be repeated here.
`;

  // Preview
  console.log();
  console.log("  ─────────────────────────────────────────────────────────");
  console.log("  Preview of CLAUDE.md:");
  console.log("  ─────────────────────────────────────────────────────────");
  for (const line of content.split("\n")) console.log(`  ${line}`);
  console.log("  ─────────────────────────────────────────────────────────");
  console.log();

  const confirm = await promptFn("  Write this CLAUDE.md? [Y/n]: ");
  if (confirm.toLowerCase() === "n") {
    console.log("  Skipped — you can create CLAUDE.md manually later.");
    return null;
  }

  return content;
}

// Write CLAUDE.md to disk and log result.
export function writeClaudeMd(claudeMdPath: string, content: string): void {
  writeFileSync(claudeMdPath, content);
  console.log("  ✓ Created CLAUDE.md");
}
