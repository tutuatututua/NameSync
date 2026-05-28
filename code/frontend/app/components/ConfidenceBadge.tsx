import { getConfidenceTier, type ConfidenceTier } from '../utils/confidence';

interface ConfidenceBadgeProps {
  score: number;
}

const TIER_STYLES: Record<ConfidenceTier, string> = {
  high: 'bg-emerald-100 text-emerald-700',
  good: 'bg-lime-100 text-lime-700',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-red-100 text-red-700',
};

export default function ConfidenceBadge({ score }: ConfidenceBadgeProps) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${TIER_STYLES[getConfidenceTier(score)]}`}>
      {score.toFixed(2)}
    </span>
  );
}
