import { Badge } from "@/components/ui/badge";
import { getConfidenceTier, confidenceLabel, confidenceClasses } from "@/lib/confidence";
import { cn } from "@/lib/utils";

/**
 * A score, its tier, and the colour of that tier — three channels saying the same thing.
 *
 * The redundancy is deliberate and is what licenses the colour: a status colour must never
 * carry meaning alone, so the number and the word ride with it. `tabular-nums` stays here
 * (unlike on a StatTile) because these stack in a table column and have to align.
 */
export function ConfidenceBadge({ score, className }: { score: number; className?: string }) {
  const tier = getConfidenceTier(score);
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 tabular-nums", confidenceClasses[tier], className)}
    >
      <span className="font-semibold">{(score * 100).toFixed(0)}%</span>
      <span className="opacity-70">{confidenceLabel[tier]}</span>
    </Badge>
  );
}
