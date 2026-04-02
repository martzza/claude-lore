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

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "claude-lore",
    version: "1.0.0",
  });

  registerReasoningTools(server);
  registerSessionTools(server);
  registerPersonalTools(server);
  registerPortfolioTools(server);
  registerAdvisorTools(server);
  registerGraphTools(server);
  registerAnnotationTools(server);
  registerReviewTools(server);
  registerStructuralTools(server);

  return server;
}
