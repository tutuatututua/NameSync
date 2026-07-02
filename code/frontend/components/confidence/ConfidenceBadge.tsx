import { Badge } from "@/components/ui/badge";
import { getConfidenceTier, confidenceLabel, confidenceClasses } from "@/lib/confidence";
import { cn } from "@/lib/utils";

export function ConfidenceBadge({ score }: { score: number }) {
  const tier = getConfidenceTier(score);
  return (
    <Badge variant="outline" className={cn("font-mono tabular-nums", confidenceClasses[tier])}>
      {(score * 100).toFixed(0)}% · {confidenceLabel[tier]}
    </Badge>
  );
}
