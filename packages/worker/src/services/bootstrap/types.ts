export type ConfidenceLevel = "confirmed" | "extracted" | "inferred" | "contested";
export type RecordType = "decision" | "deferred" | "risk";
export type ExportedTier = "personal" | "private" | "shared" | "public" | "redacted";

export interface GeneratedRecord {
  type: RecordType;
  content: string;
  rationale?: string;
  symbol?: string;
  confidence: "inferred"; // bootstrap always writes inferred — only humans confirm
  exported_tier: ExportedTier;
  anchor_status: "healthy";
}

export type QuestionType = "confirm" | "select" | "multiselect" | "text";

export interface Question {
  id: string;
  type: QuestionType;
  prompt: string;
  default?: unknown;
  options?: string[]; // for select / multiselect
}

export interface TemplateContext {
  repo: string;
  timestamp: number;
}

export interface LoreTemplate {
  id: string;
  name: string;
  description: string;
  version: string;
  hidden?: boolean; // if true, excluded from default bootstrap run and --list without --all
  questions: Question[];
  generate(
    answers: Record<string, unknown>,
    context: TemplateContext,
  ): GeneratedRecord[];
}

export interface BootstrapRunOptions {
  repo: string;
  templateIds?: string[];
  dryRun?: boolean;
}

export interface BootstrapRunResult {
  template: string;
  records: GeneratedRecord[];
  written: number;
  dry_run: boolean;
}
