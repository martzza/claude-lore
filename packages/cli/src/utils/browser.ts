import { spawn } from "child_process";

export function openInBrowser(filePath: string): void {
  const cmd =
    process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";

  spawn(cmd, [filePath], {
    detached: true,
    stdio: "ignore",
    shell: process.platform === "win32",
  }).unref();

  console.log(`Opened in browser: ${filePath}`);
}
