export type DecisionLifecycle =
  | 'active'
  | 'superseded'
  | 'historical'
  | 'archived';

export type DeferredLifecycle =
  | 'active'
  | 'completed'
  | 'abandoned'
  | 'superseded';

export type RiskLifecycle =
  | 'active'
  | 'mitigated'
  | 'accepted'
  | 'superseded'
  | 'archived';

export type ResolvedHow =
  | 'completed'
  | 'abandoned'
  | 'superseded'
  | 'merged';

export interface LifecycleTransition {
  from:  string;
  to:    string;
  at:    number;
  by:    string;
  note?: string;
}

// Staleness thresholds by record type (seconds)
export const STALENESS_THRESHOLDS = {
  decision:      180 * 24 * 60 * 60,  // 180 days — decisions are durable
  deferred_work:  30 * 24 * 60 * 60,  // 30 days  — parked items decay fast
  risk:           90 * 24 * 60 * 60,  // 90 days  — risks need periodic review
  session:        14 * 24 * 60 * 60,  // 14 days  — sessions are short-lived
} as const;

/**
 * A record is "historical" when its age exceeds the type threshold
 * AND it hasn't been reviewed recently enough to reset the clock.
 */
export function isHistorical(
  createdAt: number,
  lastReviewedAt: number | null,
  recordType: keyof typeof STALENESS_THRESHOLDS,
): boolean {
  const threshold = STALENESS_THRESHOLDS[recordType];
  const age = Date.now() / 1000 - createdAt;
  const reviewAge = lastReviewedAt ? Date.now() / 1000 - lastReviewedAt : age;
  return age > threshold && reviewAge > threshold;
}

/** Staleness score: 0.0 (fresh) → 1.0 (very stale) */
export function stalenessScore(
  createdAt: number,
  lastReviewedAt: number | null,
  recordType: keyof typeof STALENESS_THRESHOLDS,
): number {
  const threshold = STALENESS_THRESHOLDS[recordType];
  const age = Date.now() / 1000 - createdAt;
  return Math.min(1.0, age / threshold);
}
