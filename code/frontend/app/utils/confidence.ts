// Single source of truth for confidence-score thresholds so badges, dots, and
// charts stay consistent.
export type ConfidenceTier = 'high' | 'good' | 'medium' | 'low';

export function getConfidenceTier(score: number): ConfidenceTier {
  if (score >= 0.8) return 'high';
  if (score >= 0.6) return 'good';
  if (score >= 0.4) return 'medium';
  return 'low';
}
