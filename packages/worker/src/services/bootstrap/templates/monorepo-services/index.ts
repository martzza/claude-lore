import type { LoreTemplate, GeneratedRecord, TemplateContext } from "../../types.js";

const template: LoreTemplate = {
  id: "monorepo-services",
  name: "Monorepo Service Boundaries",
  description:
    "Documents service boundaries, ownership, and cross-service communication patterns. " +
    "Run this once at project start so agents understand which service they are working in " +
    "and what the blast radius of a change is across service boundaries.",
  version: "1.0.0",
  questions: [
    {
      id: "service_list",
      type: "text",
      prompt: "List the services/packages in this monorepo (comma-separated, e.g. api,worker,web,shared)",
      default: "",
    },
    {
      id: "communication_pattern",
      type: "select",
      prompt: "How do services communicate?",
      options: ["HTTP/REST", "Message queue / events", "Both HTTP and queue", "Direct shared DB (flag as risk)"],
      default: "HTTP/REST",
    },
    {
      id: "has_gateway",
      type: "confirm",
      prompt: "Is there an API gateway or BFF (Backend-for-Frontend) in front of services?",
      default: false,
    },
    {
      id: "has_shared_lib",
      type: "confirm",
      prompt: "Are there shared libraries or packages in this monorepo?",
      default: true,
    },
    {
      id: "deploy_independently",
      type: "confirm",
      prompt: "Are services deployed independently (separate CI pipelines / container images)?",
      default: true,
    },
  ],
  generate(answers: Record<string, unknown>, context: TemplateContext): GeneratedRecord[] {
    const rawList = String(answers["service_list"] ?? "").trim();
    const services = rawList
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const comms = String(answers["communication_pattern"] ?? "HTTP/REST");
    const hasGateway = answers["has_gateway"] !== false;
    const hasShared = answers["has_shared_lib"] !== false;
    const deployIndependently = answers["deploy_independently"] !== false;

    const records: GeneratedRecord[] = [];

    // --- Service inventory ---
    if (services.length > 0) {
      records.push({
        type: "decision",
        content: `Monorepo services: ${services.join(", ")}. When using MCP tools, pass service=<name> to scope queries to the correct service.`,
        rationale: "Recorded at project bootstrap so agents know the service topology and can scope reasoning queries correctly.",
        symbol: "monorepo",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
    } else {
      records.push({
        type: "decision",
        content: "Monorepo service list not specified. Run `claude-lore bootstrap --framework monorepo-services` again with service names, or add them manually via `reasoning_log`.",
        rationale: "No service names provided at bootstrap time.",
        symbol: "monorepo",
        confidence: "inferred",
        exported_tier: "private",
        anchor_status: "healthy",
      });
    }

    // --- Communication pattern ---
    const commsShort = comms.replace(" (flag as risk)", "");
    records.push({
      type: "decision",
      content: `Services communicate via: ${commsShort}. Changes to shared API contracts or message schemas require coordinated deployment.`,
      rationale: "Cross-service communication pattern established at bootstrap. Agents should flag changes that affect service boundaries.",
      symbol: "api",
      confidence: "inferred",
      exported_tier: "shared",
      anchor_status: "healthy",
    });

    // --- Shared DB risk (worst practice) ---
    if (comms.includes("Direct shared DB")) {
      records.push({
        type: "risk",
        content: "Services share a database directly. This creates hidden coupling — schema changes in one service silently break others. Migrate toward service-owned data with API contracts.",
        symbol: "db",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
    }

    // --- API gateway ---
    if (hasGateway) {
      records.push({
        type: "decision",
        content: "An API gateway or BFF sits in front of services. Route changes must be reflected in the gateway config as well as the service — check both when modifying endpoints.",
        symbol: "gateway",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
    }

    // --- Shared libraries ---
    if (hasShared) {
      records.push({
        type: "risk",
        content: "Shared library changes have cross-service blast radius. Before modifying a shared package, run `claude-lore graph portfolio` to see which services depend on it.",
        symbol: "shared",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
    }

    // --- Independent deployment ---
    if (deployIndependently) {
      records.push({
        type: "decision",
        content: "Services are deployed independently. API contract changes require a two-phase deploy: deploy the consumer with backwards-compatible handling first, then the producer.",
        rationale: "Independent deployment means there is no guaranteed deployment order. Backwards compatibility must be maintained during transitions.",
        symbol: "deploy",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
    } else {
      records.push({
        type: "decision",
        content: "Services are deployed together as a monolith/single deploy unit. Coordinated releases are required — no independent rollouts.",
        symbol: "deploy",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
    }

    // --- Deferred work ---
    records.push({
      type: "deferred",
      content: "Document service contracts and API schemas for each service boundary. Add to exports.manifest so cross-repo consumers can reference them.",
      symbol: "api",
      confidence: "inferred",
      exported_tier: "shared",
      anchor_status: "healthy",
    });

    if (services.length > 0) {
      records.push({
        type: "deferred",
        content: `Add service owners and on-call contacts to CLAUDE.md for each service: ${services.join(", ")}. Agents use this to determine who to notify when a cross-service risk is identified.`,
        symbol: "monorepo",
        confidence: "inferred",
        exported_tier: "private",
        anchor_status: "healthy",
      });
    }

    void context;
    return records;
  },
};

export default template;
