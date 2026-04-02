import { execFileSync } from "child_process";

const DEFAULT_PORT = "37778";

export async function runDashboard(opts: {
  noOpen?: boolean;
  port?: string | number;
}): Promise<void> {
  const port = String(opts.port ?? process.env["CLAUDE_LORE_PORT"] ?? DEFAULT_PORT);
  const baseUrl = `http://127.0.0.1:${port}`;
  const dashboardUrl = `${baseUrl}/dashboard`;

  // Health check
  let workerOk = false;
  try {
    const res = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    workerOk = res.ok;
  } catch { /* worker not running */ }

  if (!workerOk) {
    console.error(`Worker not running on port ${port}.`);
    console.error(`Start it with: claude-lore worker start`);
    process.exit(1);
  }

  console.log(`Dashboard: ${dashboardUrl}`);

  if (!opts.noOpen) {
    try {
      if (process.platform === "darwin") {
        execFileSync("open", [dashboardUrl], { timeout: 5000 });
        console.log("Opened in browser.");
      } else if (process.platform === "linux") {
        execFileSync("xdg-open", [dashboardUrl], { timeout: 5000 });
        console.log("Opened in browser.");
      } else {
        console.log("To open: copy the URL above into your browser.");
      }
    } catch {
      console.log("Could not open browser automatically. Open the URL above manually.");
    }
  }
}
