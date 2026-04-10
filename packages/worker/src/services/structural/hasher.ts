import { createHash } from "crypto";
import { readFileSync } from "fs";

export function hashFile(filePath: string): string | null {
  try {
    const content = readFileSync(filePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

export function hashFiles(filePaths: string[]): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const fp of filePaths) {
    const hash = hashFile(fp);
    if (hash) hashes.set(fp, hash);
  }
  return hashes;
}
