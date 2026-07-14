import { ConfidenceBadge } from "@/components/confidence/ConfidenceBadge";
import { cn } from "@/lib/utils";

/**
 * How a run ended, in one badge — defined once because it was previously decided twice, and
 * the two answers disagreed with the row they sat on.
 *
 * The trap is `topConfidence`. It's the mean of a run's ten best scores, which is the right
 * headline for a run that found something and a nonsense one for a run that didn't: a run
 * whose ten best rows are strangers at ~51% still gets badged "51% Medium", in the colour of
 * a partial success, directly beside the words "0 matches". The number is real; the thing it
 * implies is false.
 *
 * So the badge answers "did this run find anyone?" first, and only grades the find if there
 * was one.
 */
export function RunOutcome({
  status,
  matchCount,
  topConfidence,
  className,
}: {
  status: string;
  matchCount: number;
  topConfidence: number;
  className?: string;
}) {
  if (status !== "completed") {
    const failed = status === "failed";
    return (
      <span
        className={cn(
          "shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium capitalize",
          failed
            ? "border-destructive/25 bg-destructive/10 text-destructive"
            : "border-border bg-muted text-muted-foreground",
          className
        )}
      >
        {failed ? "Failed" : status === "processing" ? "Running" : status}
      </span>
    );
  }

  // Completed and empty-handed. Neutral, not red: the run did its job, the answer is just no.
  if (matchCount === 0) {
    return (
      <span
        className={cn(
          "shrink-0 whitespace-nowrap rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground",
          className
        )}
      >
        No matches
      </span>
    );
  }

  return <ConfidenceBadge score={topConfidence} className={cn("shrink-0", className)} />;
}
