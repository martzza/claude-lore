import type { LoreTemplate, GeneratedRecord, TemplateContext } from "../../types.js";

// OWASP Top 10 (2021) — https://owasp.org/Top10/
const OWASP_RISKS: Array<{
  id: string;
  title: string;
  content: string;
  symbol?: string;
}> = [
  {
    id: "A01",
    title: "Broken Access Control",
    content:
      "A01:2021 Broken Access Control — verify all routes enforce authorisation. " +
      "Check middleware order; confirm no endpoint is reachable without auth.",
    symbol: "auth",
  },
  {
    id: "A02",
    title: "Cryptographic Failures",
    content:
      "A02:2021 Cryptographic Failures — ensure secrets are never logged or committed. " +
      "Verify TLS on all external connections; confirm passwords are hashed with bcrypt/argon2.",
    symbol: "crypto",
  },
  {
    id: "A03",
    title: "Injection",
    content:
      "A03:2021 Injection — all SQL must use parameterised queries with positional `?` args. " +
      "No string concatenation into SQL. Validate and sanitise all user input at system boundaries.",
    symbol: "db",
  },
  {
    id: "A04",
    title: "Insecure Design",
    content:
      "A04:2021 Insecure Design — threat-model new features before implementation. " +
      "Document trust boundaries; do not add features that require weakening existing security controls.",
  },
  {
    id: "A05",
    title: "Security Misconfiguration",
    content:
      "A05:2021 Security Misconfiguration — default credentials, open debug endpoints, " +
      "and stack traces in prod responses must be eliminated. Review all env-var defaults.",
    symbol: "config",
  },
  {
    id: "A06",
    title: "Vulnerable and Outdated Components",
    content:
      "A06:2021 Vulnerable and Outdated Components — run `pnpm audit` in CI. " +
      "Pin major versions; review changelogs when upgrading. No unaudited dependencies in prod.",
    symbol: "package.json",
  },
  {
    id: "A07",
    title: "Identification and Authentication Failures",
    content:
      "A07:2021 Identification and Authentication Failures — session tokens must be random, " +
      "rotated on privilege change, and expire. MFA required for admin paths.",
    symbol: "session",
  },
  {
    id: "A08",
    title: "Software and Data Integrity Failures",
    content:
      "A08:2021 Software and Data Integrity Failures — verify dependency integrity (lockfile committed, " +
      "checksums validated in CI). No unsigned builds reaching production.",
  },
  {
    id: "A09",
    title: "Security Logging and Monitoring Failures",
    content:
      "A09:2021 Security Logging and Monitoring Failures — all auth events, access-control failures, " +
      "and input validation failures must be logged. Logs must not contain secrets or PII.",
    symbol: "logger",
  },
  {
    id: "A10",
    title: "Server-Side Request Forgery (SSRF)",
    content:
      "A10:2021 SSRF — all outbound HTTP calls must validate the target URL against an allowlist. " +
      "Never pass user-supplied URLs directly to fetch/axios/http.request.",
    symbol: "fetch",
  },
];

const template: LoreTemplate = {
  id: "owasp-top10",
  name: "OWASP Top 10 (2021)",
  description:
    "Adds OWASP Top 10 (2021) as risk records anchored to common symbol patterns. " +
    "Use as a baseline security checklist for any new service.",
  version: "1.0.0",
  questions: [
    {
      id: "categories",
      type: "multiselect",
      prompt: "Which OWASP categories apply to this repo?",
      default: "all",
      options: OWASP_RISKS.map((r) => r.id),
    },
  ],
  generate(
    answers: Record<string, unknown>,
    _context: TemplateContext,
  ): GeneratedRecord[] {
    const selected = answers["categories"];
    const filter =
      selected === "all" || !Array.isArray(selected)
        ? null
        : new Set(selected as string[]);

    return OWASP_RISKS.filter((r) => filter === null || filter.has(r.id)).map(
      (r): GeneratedRecord => ({
        type: "risk",
        content: r.content,
        rationale: `OWASP Top 10 (2021) — ${r.id}: ${r.title}`,
        symbol: r.symbol,
        confidence: "inferred",
        exported_tier: "private",
        anchor_status: "healthy",
      }),
    );
  },
};

export default template;
