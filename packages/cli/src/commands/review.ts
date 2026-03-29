// Review loop stub — Phase 2 implementation
export async function runReview(): Promise<void> {
  const PORT = process.env["CLAUDE_LORE_PORT"] ?? "37778";

  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    if (!res.ok) throw new Error("unhealthy");
  } catch {
    console.error("Worker not running. Start it with: claude-lore worker start");
    process.exit(1);
  }

  console.log("Review loop for extracted records — Phase 2 feature");
  console.log("(Phase 1 stub — human confirmation workflow implemented in Phase 2)");
}
