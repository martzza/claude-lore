import type { LoreTemplate, GeneratedRecord, TemplateContext } from "../../types.js";

/**
 * Security Checklist — operational security beyond OWASP.
 *
 * Covers: secrets management, CI/CD hardening, branch protection, production
 * access control, dependency audit cadence, audit logging, and data classification.
 *
 * Complements the owasp-top10 template (code-level vulnerabilities).
 * This template covers process and infrastructure security.
 */

const template: LoreTemplate = {
  id: "security-checklist",
  name: "Security Checklist",
  description:
    "Operational security baseline covering secrets management, CI/CD hardening, branch protection, " +
    "production access controls, dependency audit cadence, and data classification. " +
    "Complements the owasp-top10 template which covers code-level vulnerabilities.",
  version: "1.0.0",
  questions: [
    {
      id: "has_secrets_manager",
      type: "confirm",
      prompt: "Are secrets stored in a secrets manager (Vault, AWS Secrets Manager, Doppler, etc.) rather than .env files?",
      default: false,
    },
    {
      id: "has_ci_cd",
      type: "confirm",
      prompt: "Does this project have a CI/CD pipeline?",
      default: true,
    },
    {
      id: "has_branch_protection",
      type: "confirm",
      prompt: "Is branch protection enabled on main/master (requires PR + review before merge)?",
      default: false,
    },
    {
      id: "prod_access",
      type: "select",
      prompt: "Who has direct production access (shell/DB)?",
      options: [
        "No direct access — everything via CI/CD",
        "Specific named engineers only (least privilege)",
        "Anyone on the team",
        "Unknown / not audited",
      ],
      default: "Unknown / not audited",
    },
    {
      id: "audit_cadence",
      type: "select",
      prompt: "How often are dependencies audited for vulnerabilities?",
      options: ["Every PR (CI)", "Weekly (scheduled)", "Monthly or less", "Not automated"],
      default: "Not automated",
    },
    {
      id: "has_audit_logging",
      type: "confirm",
      prompt: "Are sensitive operations (auth events, admin actions, data exports) logged with user identity?",
      default: false,
    },
    {
      id: "data_classification",
      type: "confirm",
      prompt: "Is the data handled by this service classified (PII, PCI, PHI, confidential, public)?",
      default: false,
    },
  ],
  generate(answers: Record<string, unknown>, context: TemplateContext): GeneratedRecord[] {
    const hasSecretsManager = answers["has_secrets_manager"] !== false;
    const hasCiCd = answers["has_ci_cd"] !== false;
    const hasBranchProtection = answers["has_branch_protection"] !== false;
    const prodAccess = String(answers["prod_access"] ?? "Unknown / not audited");
    const auditCadence = String(answers["audit_cadence"] ?? "Not automated");
    const hasAuditLogging = answers["has_audit_logging"] !== false;
    const dataClassified = answers["data_classification"] !== false;

    const records: GeneratedRecord[] = [];

    // ── Secrets management ──────────────────────────────────────────────────
    if (hasSecretsManager) {
      records.push({
        type: "decision",
        content:
          "Secrets are managed via a secrets manager (not .env files). Never commit secrets to git. " +
          "When adding a new secret: add it to the secrets manager, reference it via env var, " +
          "and document the env var name (not value) in CLAUDE.md.",
        symbol: "config",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
    } else {
      records.push({
        type: "risk",
        content:
          "Secrets are not stored in a dedicated secrets manager. Risk of secrets leaking via .env files, " +
          "git history, or process inspection. Migrate to a secrets manager (Vault, AWS Secrets Manager, Doppler) " +
          "and ensure .env is in .gitignore with pre-commit hook to block accidental commits.",
        symbol: "config",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
      records.push({
        type: "deferred",
        content: "Migrate secrets to a dedicated secrets manager. Add .env to .gitignore. Add pre-commit hook that blocks files matching *.env or containing SECRET/TOKEN/PASSWORD patterns.",
        symbol: "config",
        confidence: "inferred",
        exported_tier: "private",
        anchor_status: "healthy",
      });
    }

    // ── CI/CD hardening ──────────────────────────────────────────────────────
    if (hasCiCd) {
      records.push({
        type: "decision",
        content:
          "CI/CD pipeline is in use. Secrets must be injected via CI environment variables, never hardcoded in pipeline config. " +
          "Pipeline config files (GitHub Actions, GitLab CI, etc.) should be treated as code — reviewed on every PR.",
        symbol: "ci",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
      records.push({
        type: "risk",
        content:
          "CI/CD pipelines with write access to production are a high-value attack target. " +
          "Pin third-party actions to a specific commit SHA (not a tag), restrict GITHUB_TOKEN permissions to least privilege, " +
          "and audit who can trigger deployments.",
        symbol: "ci",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
    } else {
      records.push({
        type: "risk",
        content:
          "No CI/CD pipeline detected. Manual deployments increase risk of human error and make it harder to enforce " +
          "security gates (tests, audits, linting). Consider adding CI/CD with mandatory security checks before merge.",
        symbol: "ci",
        confidence: "inferred",
        exported_tier: "private",
        anchor_status: "healthy",
      });
    }

    // ── Branch protection ────────────────────────────────────────────────────
    if (hasBranchProtection) {
      records.push({
        type: "decision",
        content:
          "Branch protection is enabled on main/master. All changes must go through a PR with at least one reviewer. " +
          "Force-push to main is blocked. Status checks (CI) must pass before merge.",
        symbol: "git",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
    } else {
      records.push({
        type: "risk",
        content:
          "Branch protection is NOT enabled on main. Any team member can push directly to main, bypassing review and CI. " +
          "Enable branch protection rules: require PR, require review, require status checks, block force push.",
        symbol: "git",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
      records.push({
        type: "deferred",
        content: "Enable branch protection on main/master. Settings: require PR + 1 reviewer, require CI to pass, block direct push, block force push.",
        symbol: "git",
        confidence: "inferred",
        exported_tier: "private",
        anchor_status: "healthy",
      });
    }

    // ── Production access ────────────────────────────────────────────────────
    if (prodAccess === "No direct access — everything via CI/CD") {
      records.push({
        type: "decision",
        content:
          "Production access is restricted to CI/CD pipelines only — no human shell or DB access. " +
          "All production changes must go through the deployment pipeline with audit trail.",
        symbol: "infra",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
    } else if (prodAccess === "Anyone on the team") {
      records.push({
        type: "risk",
        content:
          "All team members have direct production access. This violates least-privilege. " +
          "Restrict production access to named individuals with a documented business need, " +
          "require MFA, and log all access events.",
        symbol: "infra",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
    } else if (prodAccess === "Unknown / not audited") {
      records.push({
        type: "risk",
        content:
          "Production access has not been audited. Unknown who has direct shell or DB access to production environments. " +
          "Audit production IAM/SSH access immediately and revoke any access that cannot be justified.",
        symbol: "infra",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
      records.push({
        type: "deferred",
        content: "Audit production access: list all IAM roles, SSH keys, and DB users with production access. Remove any that are not actively needed. Enforce MFA on all remaining accounts.",
        symbol: "infra",
        confidence: "inferred",
        exported_tier: "private",
        anchor_status: "healthy",
      });
    } else {
      // Specific named engineers
      records.push({
        type: "decision",
        content:
          "Direct production access is restricted to specific named engineers. " +
          "Access should be reviewed quarterly and revoked when engineers change roles.",
        symbol: "infra",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
    }

    // ── Dependency audit cadence ─────────────────────────────────────────────
    if (auditCadence === "Every PR (CI)") {
      records.push({
        type: "decision",
        content:
          "Dependency vulnerabilities are checked on every PR via CI (npm audit / pnpm audit / bun audit). " +
          "PRs with high or critical severity findings must not be merged without remediation or explicit exception approval.",
        symbol: "package.json",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
    } else if (auditCadence === "Not automated") {
      records.push({
        type: "risk",
        content:
          "Dependency vulnerability scanning is not automated. New CVEs can go undetected indefinitely. " +
          "Add `pnpm audit --audit-level=high` (or equivalent) to CI and fail the build on high/critical findings.",
        symbol: "package.json",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
      records.push({
        type: "deferred",
        content: "Add dependency audit to CI pipeline. Use `pnpm audit --audit-level=high` or Dependabot/Renovate for automated PRs on vulnerable dependencies.",
        symbol: "package.json",
        confidence: "inferred",
        exported_tier: "private",
        anchor_status: "healthy",
      });
    } else {
      records.push({
        type: "decision",
        content: `Dependency vulnerability scanning runs ${auditCadence.toLowerCase()}. Upgrade to CI-level scanning (every PR) to catch vulnerabilities before they reach main.`,
        symbol: "package.json",
        confidence: "inferred",
        exported_tier: "private",
        anchor_status: "healthy",
      });
    }

    // ── Audit logging ────────────────────────────────────────────────────────
    if (hasAuditLogging) {
      records.push({
        type: "decision",
        content:
          "Sensitive operations (auth events, admin actions, data exports) are logged with user identity and timestamp. " +
          "Audit logs must be append-only and stored separately from application logs. Retain for at least 90 days.",
        symbol: "logging",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
    } else {
      records.push({
        type: "risk",
        content:
          "Sensitive operations are not audit-logged. Without an audit trail, security incidents cannot be investigated, " +
          "compliance requirements (SOC2, GDPR, HIPAA) cannot be met, and insider threats go undetected. " +
          "Add structured logging for: login/logout, permission changes, data exports, admin mutations.",
        symbol: "logging",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
      records.push({
        type: "deferred",
        content: "Implement audit logging for: authentication events (success + failure), permission changes, admin actions, bulk data exports. Include: user_id, ip, timestamp, action, resource_id.",
        symbol: "logging",
        confidence: "inferred",
        exported_tier: "private",
        anchor_status: "healthy",
      });
    }

    // ── Data classification ──────────────────────────────────────────────────
    if (dataClassified) {
      records.push({
        type: "decision",
        content:
          "Data handled by this service is classified. When reading or writing classified data, confirm: " +
          "(1) access is authorised for the requesting user, (2) data is not logged in plaintext, " +
          "(3) data is encrypted at rest and in transit, (4) retention limits are enforced.",
        symbol: "data",
        confidence: "inferred",
        exported_tier: "shared",
        anchor_status: "healthy",
      });
    } else {
      records.push({
        type: "deferred",
        content: "Classify data handled by this service (PII, PCI, PHI, confidential, or public). Document classification in CLAUDE.md so agents apply appropriate handling rules automatically.",
        symbol: "data",
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
