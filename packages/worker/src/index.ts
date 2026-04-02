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

const PORT = parseInt(process.env["CLAUDE_LORE_PORT"] ?? "37778", 10);

async function main(): Promise<void> {
  await initDb();

  const app = express();
  app.use(express.json());
  app.use(authMiddleware);

  // Auth management — exempt from scope checks (bootstrap endpoint)
  app.use("/api/auth", authRouter);

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      version: "0.9.0",
      port: PORT,
      ts: Date.now(),
      turso: getTursoStatus(),
      advisor: { enabled: true, last_run: null },
      graph: { enabled: true },
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

main().catch((err) => {
  console.error("Worker startup failed:", err);
  process.exit(1);
});
