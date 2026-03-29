#!/usr/bin/env bun
/**
 * claude-lore MCP server entry point (stdio transport for local dev).
 *
 * Claude Code plugin:
 *   "mcp": { "command": "bun", "args": ["run", "${CLAUDE_PLUGIN_ROOT}/../../packages/worker/mcp.ts"] }
 *
 * Cursor mcp.json:
 *   { "mcpServers": { "claude-lore": { "command": "bun", "args": ["run", "/path/to/packages/worker/mcp.ts"] } } }
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initDb } from "./src/services/sqlite/db.js";
import { createMcpServer } from "./src/mcp/server.js";

async function main(): Promise<void> {
  await initDb();

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server startup failed:", err);
  process.exit(1);
});
