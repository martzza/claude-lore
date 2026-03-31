import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";

const CONFIG_PATH = join(homedir(), ".codegraph", "config.json");

export type LoreMode = "solo" | "team";

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function readConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(join(homedir(), ".codegraph"), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export async function runModeShow(): Promise<void> {
  const config = readConfig();
  const mode: LoreMode = config["mode"] === "team" ? "team" : "solo";
  const hasTurso =
    typeof config["turso_url"] === "string" && (config["turso_url"] as string).length > 0;

  console.log(`Mode:       ${mode}`);
  console.log(`Turso sync: ${hasTurso ? "configured" : "not configured"}`);

  if (mode === "solo") {
    console.log(
      "\nSolo mode — local-only, no auth required, no team sync.",
    );
    console.log("Upgrade to team mode:  claude-lore mode set team");
  } else {
    console.log("\nTeam mode — auth tokens required, Turso sync active.");
    console.log("Downgrade to solo mode:  claude-lore mode set solo");
  }
}

export async function runModeSet(mode: string): Promise<void> {
  if (mode !== "solo" && mode !== "team") {
    console.error("Invalid mode. Valid values: solo | team");
    process.exit(1);
  }

  const config = readConfig();

  if (mode === "team") {
    const hasTurso =
      typeof config["turso_url"] === "string" && (config["turso_url"] as string).length > 0;
    if (!hasTurso) {
      console.log("Team mode requires Turso sync to be configured first.");
      console.log("");
      console.log("  Create a free database at https://turso.tech");
      console.log("  turso db show <name> --url");
      console.log("  turso db tokens create <name>");
      console.log("");
      const doSetup = await prompt("Set up Turso now? (y/N): ");
      if (doSetup.toLowerCase() === "y" || doSetup.toLowerCase() === "yes") {
        const tursoUrl = await prompt("Turso database URL (libsql://...): ");
        const tursoToken = await prompt("Auth token: ");
        if (!tursoUrl.startsWith("libsql://") || tursoToken.length === 0) {
          console.log("Invalid URL or empty token — aborting.");
          process.exit(1);
        }
        config["turso_url"] = tursoUrl;
        config["turso_auth_token"] = tursoToken;
        console.log("✓ Turso credentials saved");
      } else {
        console.log("Aborted. Configure Turso first, then re-run: claude-lore mode set team");
        process.exit(1);
      }
    }
  }

  config["mode"] = mode;
  writeConfig(config);
  console.log(`✓ Mode set to: ${mode}`);

  if (mode === "team") {
    console.log(
      "\nTeam mode active. Auth tokens are now required for write operations.",
    );
    console.log("Generate a token:  claude-lore auth generate <your-name>");
    console.log("Restart worker to activate sync:  claude-lore worker restart");
  } else {
    console.log(
      "\nSolo mode active. Auth tokens are optional — localhost access is unrestricted.",
    );
  }
}
