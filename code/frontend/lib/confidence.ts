import { MATCH_THRESHOLD, isMatch } from "@extensions/contract";

/**
 * `isMatch` is re-exported, not redefined. The API counts matches with it too (it derives
 * `matchCount` on every run), and a UI that drew the line anywhere else would show a table of
 * 13 rows under a heading that said 11.
 */
export { MATCH_THRESHOLD, isMatch };

export type ConfidenceTier = "high" | "good" | "medium" | "low";

/** Best to worst — the order the legend and any tier list should walk. */
export const CONFIDENCE_TIERS: readonly ConfidenceTier[] = ["high", "good", "medium", "low"] as const;

/**
 * Single source of truth for confidence tiers (thresholds 0.8 / 0.6 / 0.4).
 *
 * The "good" boundary is MATCH_THRESHOLD: high and good are matches, medium and low are not.
 * The tiers grade a match; `isMatch` decides whether there is one to grade.
 */
export function getConfidenceTier(score: number): ConfidenceTier {
  if (score >= 0.8) return "high";
  if (score >= MATCH_THRESHOLD) return "good";
  if (score >= 0.4) return "medium";
  return "low";
}

export const confidenceLabel: Record<ConfidenceTier, string> = {
  high: "High",
  good: "Good",
  medium: "Medium",
  low: "Low",
};

/**
 * Tier colour as *text*, on a 10% tint of itself — the badge.
 *
 * That combination is the binding constraint on the `--confidence-*` tokens: it is
 * ordinary-size text, so it owes 4.5:1 against the tint, which is a stricter bar than the
 * 3:1 a chart mark owes the surface. The tokens were picked by validating that number
 * rather than by eye.
 */
export const confidenceClasses: Record<ConfidenceTier, string> = {
  high: "text-confidence-high border-confidence-high/25 bg-confidence-high/10",
  good: "text-confidence-good border-confidence-good/25 bg-confidence-good/10",
  medium: "text-confidence-medium border-confidence-medium/25 bg-confidence-medium/10",
  low: "text-confidence-low border-confidence-low/25 bg-confidence-low/10",
};

/** Tier colour as a solid mark — the swatch on the results table's tier filters. */
export const confidenceBar: Record<ConfidenceTier, string> = {
  high: "bg-confidence-high",
  good: "bg-confidence-good",
  medium: "bg-confidence-medium",
  low: "bg-confidence-low",
};
