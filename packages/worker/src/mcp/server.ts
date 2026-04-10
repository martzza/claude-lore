import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReasoningTools } from "./tools/reasoning.js";
import { registerSessionTools } from "./tools/sessions.js";
import { registerPersonalTools } from "./tools/personal.js";
import { registerPortfolioTools } from "./tools/portfolio.js";
import { registerAdvisorTools } from "./tools/advisor.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerAnnotationTools } from "./tools/annotation.js";
import { registerReviewTools } from "./tools/review.js";
import { registerStructuralTools } from "./tools/structural.js";
import { registerCompressionTools } from "./tools/compression.js";

// ---------------------------------------------------------------------------
// MCP stats — module-level, read by GET /api/mcp/stats
// ---------------------------------------------------------------------------

interface McpStats {
  totalCalls:  number;
  lastCallAt:  number | null;
  callsToday:  number;
  toolCount:   number;
}

const _mcpStats: McpStats = {
  totalCalls: 0,
  lastCallAt: null,
  callsToday: 0,
  toolCount:  37,
};

let _todayDate = new Date().toDateString();

export function recordMcpCall(): void {
  _mcpStats.totalCalls++;
  _mcpStats.lastCallAt = Date.now();
  const today = new Date().toDateString();
  if (today !== _todayDate) {
    _todayDate = today;
    _mcpStats.callsToday = 0;
  }
  _mcpStats.callsToday++;
}

export function getMcpStats(): McpStats {
  return { ..._mcpStats };
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "claude-lore",
    version: "1.1.0",
  });

  // Wrap the server's tool call dispatch to track stats.
  // McpServer exposes a `tool` registration method; we intercept calls via the
  // request handler by patching the internal _requestHandlers map after setup.
  registerStructuralTools(server);
  registerReasoningTools(server);
  registerSessionTools(server);
  registerPersonalTools(server);
  registerPortfolioTools(server);
  registerAdvisorTools(server);
  registerGraphTools(server);
  registerAnnotationTools(server);
  registerReviewTools(server);
  registerCompressionTools(server);

  // Patch the tools/call handler to increment counters on every invocation.
  // The MCP SDK stores request handlers on the underlying Server instance as
  // _server._requestHandlers (a Map<string, fn>).
  try {
    const inner = (server as unknown as { _server: { _requestHandlers: Map<string, unknown> } })._server;
    if (inner?._requestHandlers) {
      const orig = inner._requestHandlers.get("tools/call");
      if (typeof orig === "function") {
        inner._requestHandlers.set("tools/call", async (...args: unknown[]) => {
          recordMcpCall();
          return (orig as (...a: unknown[]) => unknown)(...args);
        });
      }
    }
  } catch { /* safe — stats are optional */ }

  return server;
}
