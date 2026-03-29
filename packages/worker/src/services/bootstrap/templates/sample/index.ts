import type { LoreTemplate, GeneratedRecord, TemplateContext } from "../../types.js";

const template: LoreTemplate = {
  id: "sample",
  name: "Sample Template",
  description:
    "Reference implementation. Shows how to write a bootstrap template — copy this to create your own.",
  version: "1.0.0",
  hidden: true, // opt-in only: use --framework sample to run
  questions: [
    {
      id: "service_name",
      type: "text",
      prompt: "What is the name of this service?",
      default: "my-service",
    },
    {
      id: "include_deferred",
      type: "confirm",
      prompt: "Include sample deferred work items?",
      default: true,
    },
  ],
  generate(
    answers: Record<string, unknown>,
    context: TemplateContext,
  ): GeneratedRecord[] {
    const service = String(answers["service_name"] ?? "my-service");
    const includeDeferred = answers["include_deferred"] !== false;

    const records: GeneratedRecord[] = [
      {
        type: "decision",
        content: `${service} uses this tech stack — see package.json for exact versions`,
        rationale:
          "Bootstrapped from the sample template. Replace this with real decisions.",
        confidence: "inferred",
        exported_tier: "private",
        anchor_status: "healthy",
      },
      {
        type: "risk",
        content: `Dependencies in ${service} should be audited before first production deploy`,
        rationale: "Standard risk for a new service — run npm audit or bun audit.",
        confidence: "inferred",
        exported_tier: "private",
        anchor_status: "healthy",
      },
    ];

    if (includeDeferred) {
      records.push({
        type: "deferred",
        content: `Add README.md for ${service}`,
        rationale: "Commonly deferred during initial setup.",
        confidence: "inferred",
        exported_tier: "private",
        anchor_status: "healthy",
      });
    }

    return records;
  },
};

export default template;
