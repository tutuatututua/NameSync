export type ConfidenceTier = "high" | "good" | "medium" | "low";

/** Single source of truth for confidence tiers (thresholds 0.8 / 0.6 / 0.4). */
export function getConfidenceTier(score: number): ConfidenceTier {
  if (score >= 0.8) return "high";
  if (score >= 0.6) return "good";
  if (score >= 0.4) return "medium";
  return "low";
}

export const confidenceLabel: Record<ConfidenceTier, string> = {
  high: "High",
  good: "Good",
  medium: "Medium",
  low: "Low",
};

/** Text + subtle background tint per tier, keyed to the --confidence-* tokens. */
export const confidenceClasses: Record<ConfidenceTier, string> = {
  high: "text-confidence-high border-confidence-high/30 bg-confidence-high/10",
  good: "text-confidence-good border-confidence-good/30 bg-confidence-good/10",
  medium: "text-confidence-medium border-confidence-medium/30 bg-confidence-medium/10",
  low: "text-confidence-low border-confidence-low/30 bg-confidence-low/10",
};

export const confidenceBar: Record<ConfidenceTier, string> = {
  high: "bg-confidence-high",
  good: "bg-confidence-good",
  medium: "bg-confidence-medium",
  low: "bg-confidence-low",
};
