import { cn } from "@/lib/utils";

/**
 * How a run ended, in one badge — defined once because it was previously decided twice, and
 * the two answers disagreed with the row they sat on.
 *
 * It used to end on a `topConfidence` grade: the mean of a run's ten best scores, badged as
 * "87% High". That number went with `matching_score`, and the badge is better for losing it — it
 * was the component's own documented trap. A run whose ten best rows were strangers at ~51% still
 * badged "51% Medium", in the colour of a partial success, directly beside the words "0 matches".
 *
 * What is left is the question that mattered anyway: did this run find anyone, and how many. The
 * grade is gone rather than replaced, because there is nothing left to grade with — every match is
 * now equally a match.
 */
export function RunOutcome({
  status,
  matchCount,
  className,
}: {
  status: string;
  matchCount: number;
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

  // Found something. Primary-tinted rather than neutral, so a run with a finding is visibly
  // different from one without at a glance down the list — which is the whole job of this badge.
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap rounded-md border border-primary/25 bg-primary/10 px-2 py-0.5 text-xs font-medium tabular-nums text-primary",
        className
      )}
    >
      {matchCount.toLocaleString()} {matchCount === 1 ? "match" : "matches"}
    </span>
  );
}
