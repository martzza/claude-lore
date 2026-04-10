import express from "express";
import { initDb, getTursoStatus, hasTurso } from "./services/sqlite/db.js";
import { runSync } from "./services/sync/service.js";
import { authMiddleware } from "./middleware/auth.js";
import authRouter from "./routes/auth.js";
import sessionsRouter from "./routes/sessions.js";
import contextRouter from "./routes/context.js";
import recordsRouter from "./routes/records.js";
import bootstrapRouter from "./routes/bootstrap.js";
import manifestRouter from "./routes/manifest.js";
import stalenessRouter from "./routes/staleness.js";
import skillsRouter from "./routes/skills.js";
import coverageRouter from "./routes/coverage.js";
import adrRouter from "./routes/adr.js";
import advisorRouter from "./routes/advisor.js";
import portfolioRouter from "./routes/portfolio.js";
import graphRouter from "./routes/graph.js";
import annotationRouter from "./routes/annotation.js";
import reviewRouter from "./routes/review.js";
import syncRouter from "./routes/sync.js";
import memoryRouter from "./routes/memory.js";
import auditRouter from "./routes/audit.js";
import doctorRouter from "./routes/doctor.js";
import structuralRouter from "./routes/structural.js";
import dashboardRouter from "./routes/dashboard.js";
import { getIndexStats } from "./services/structural/indexer.js";

const PORT = parseInt(process.env["CLAUDE_LORE_PORT"] ?? "37778", 10);

async function main(): Promise<void> {
  await initDb();

  const app = express();
  app.use(express.json());
  app.use(authMiddleware);

  // Auth management — exempt from scope checks (bootstrap endpoint)
  app.use("/api/auth", authRouter);

  app.get("/health", async (_req, res) => {
    let structural: { indexed: boolean; symbol_count?: number; edge_count?: number; indexed_at?: number } = { indexed: false };
    try {
      const stats = await getIndexStats(process.cwd(), process.cwd());
      if (stats) {
        structural = {
          indexed:      true,
          symbol_count: stats.symbol_count,
          edge_count:   stats.edge_count,
          indexed_at:   stats.indexed_at,
        };
      }
    } catch { /* ok */ }

    res.json({
      status: "ok",
      version: "1.1.0",
      port: PORT,
      ts: Date.now(),
      turso: getTursoStatus(),
      advisor: { enabled: true, last_run: null },
      graph: { enabled: true },
      structural,
      dashboard: { url: `http://127.0.0.1:${PORT}/dashboard` },
    });
  });

  app.use("/api/sessions", sessionsRouter);
  app.use("/api/context", contextRouter);
  app.use("/api/records", recordsRouter);
  app.use("/api/bootstrap", bootstrapRouter);
  app.use("/api/manifest", manifestRouter);
  app.use("/api/staleness", stalenessRouter);
  app.use("/api/skills", skillsRouter);
  app.use("/api/coverage", coverageRouter);
  app.use("/api/adr", adrRouter);
  app.use("/api/advisor", advisorRouter);
  app.use("/api/portfolio", portfolioRouter);
  app.use("/api/graph", graphRouter);
  app.use("/api/annotation", annotationRouter);
  app.use("/api/review", reviewRouter);
  app.use("/api/sync", syncRouter);
  app.use("/api/memory", memoryRouter);
  app.use("/api/audit", auditRouter);
  app.use("/api/doctor", doctorRouter);
  app.use("/api/structural", structuralRouter);

  // Dashboard — HTML page + API endpoints (all served from single router)
  app.use("/", dashboardRouter);

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`claude-lore worker listening on http://127.0.0.1:${PORT}`);

    // Periodic sync every 5 minutes when Turso is configured
    if (hasTurso()) {
      const SYNC_INTERVAL_MS = 5 * 60 * 1000;
      setInterval(() => {
        runSync().catch((err) => console.error("[sync] periodic sync error:", err));
      }, SYNC_INTERVAL_MS);
      console.log("[sync] Turso connected — periodic sync every 5 minutes");
    }
  });
}

process.on("unhandledRejection", (err) => {
  console.error("[worker] unhandledRejection:", err);
});

main().catch((err) => {
  console.error("Worker startup failed:", err);
  process.exit(1);
});
