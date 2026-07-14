"use client";

import { Loader2, TriangleAlert, UserCheck, UserX } from "lucide-react";
import type { ComparisonProgress } from "@extensions/contract";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

/**
 * A run the external workflow is still working on.
 *
 * The numbers are real, not a spinner with a percentage painted on it: the workflow stamps
 * each uploaded row as it finishes with it, and this is a count of those stamps. So the bar
 * cannot get ahead of the work, and it cannot sit at 99% — every point of it is a row that
 * has actually been decided.
 *
 * Matched and unmatched are shown *while it runs*, not just at the end, because they are the
 * answer arriving. A user watching an import of 300 friends wants to know it has found four
 * people at minute one; making them wait for a completion event to learn that would be
 * withholding an answer the database already has.
 */
export function RunProgress({ progress }: { progress: ComparisonProgress }) {
  const { total, pending, matched, unmatched, failed, percent } = progress;
  const done = total - pending;

  return (
    <Card>
      <CardContent className="space-y-5 p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border bg-muted">
            <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden />
          </span>
          <div className="min-w-0 space-y-1">
            <h2 className="font-display text-xl font-semibold leading-tight tracking-tight">
              Matching your import…
            </h2>
            <p className="text-sm text-muted-foreground">
              Every name you uploaded is being compared against the names already on file. This
              keeps running if you leave — the run is saved, and it&apos;s in Past runs.
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          {/* aria-live so a screen-reader user is told it is progressing, rather than left on a
              page that silently changes. Polite: it is an update, not an alarm. */}
          <Progress value={percent} aria-label="Matching progress" />
          <div
            aria-live="polite"
            className="flex items-center justify-between text-xs tabular-nums text-muted-foreground"
          >
            <span>
              {done.toLocaleString()} of {total.toLocaleString()} rows
            </span>
            <span>{percent}%</span>
          </div>
        </div>

        {/* Only once there is something to say. A row of zeroes in the first second of a run
            reads as "found nothing", which is a claim the run has not made yet. */}
        {done > 0 && (
          <dl className="flex flex-wrap gap-x-8 gap-y-2 border-t pt-4">
            <Tally icon={UserCheck} value={matched} label="matched so far" tone="text-confidence-high" />
            <Tally icon={UserX} value={unmatched} label="no match" tone="text-muted-foreground" />
            {/* Shown only when it happens, and never folded into "no match" — those are
                different claims. "Nobody matches this name" is an answer; "we couldn't compare
                this name" is a broken row, and it is the only one of the two worth acting on.
                Counted together, a workflow erroring on half an import would look exactly like
                an import that simply found nothing. */}
            {failed > 0 && (
              <Tally icon={TriangleAlert} value={failed} label="failed" tone="text-destructive" />
            )}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function Tally({
  icon: Icon,
  value,
  label,
  tone,
}: {
  icon: typeof UserCheck;
  value: number;
  label: string;
  tone: string;
}) {
  return (
    <div className="space-y-0.5">
      <dd className={`font-display text-2xl font-semibold leading-none tabular-nums ${tone}`}>
        {value.toLocaleString()}
      </dd>
      <dt className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" aria-hidden />
        {label}
      </dt>
    </div>
  );
}
