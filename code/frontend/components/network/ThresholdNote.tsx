"use client";

import Link from "next/link";
import { SlidersHorizontal } from "lucide-react";
import { formatThreshold } from "@extensions/contract";
import { withThreshold } from "@/hooks/useThreshold";
import { cn } from "@/lib/utils";

/**
 * "This page is being read at 80%" — the bar, stated on a page that carries one but cannot move it.
 *
 * ── WHY A DRILL-DOWN NEEDS TO SAY THIS ──
 *
 * The bar travels from the Network page into a roster and a company page on every link, and until
 * now it arrived INVISIBLY: the numbers were graded, the URL said so, and the page said nothing. A
 * reader who tuned the workspace to 60% and clicked a relationship owner had no way to tell the
 * difference between "the bar came with me" and "the bar was dropped" — the two look identical, and
 * one of them was a real bug (see `Provenance` and the run page). Reporting it as broken was the
 * correct reading of what was on screen.
 *
 * So the page names the bar it is reading at, which is the same rule `NetworkThreshold` holds to on
 * the workspace: every paint says what it is showing, and says that nothing stored has changed.
 *
 * ── A STATEMENT, NOT A SECOND CONTROL ──
 *
 * It is a sentence and a link back, deliberately. A slider here would be a second authority over one
 * setting — the thing the roster and company pages have refused from the start, and rightly: two
 * copies of a control have to be kept in step, and the one that loses the race silently disagrees
 * with the other about the same database. Changing the bar means going back to where it lives, and
 * that link carries the current value so arriving there is a continuation rather than a reset.
 */
export function ThresholdNote({
  threshold,
  changeHref,
  className,
}: {
  /** The bar this page's numbers were fetched at; null for the matchers' own verdicts. */
  threshold: number | null;
  /** Where the control actually lives — the workspace tab this page was drilled into from. The
   *  current bar is hung on it here, so "change it" opens on the value being changed. */
  changeHref: string;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground",
        className
      )}
    >
      <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {threshold === null ? (
        // The explicit opt-out (`?threshold=off`). Worth its own sentence rather than a blank: a
        // page reading at each matcher's own bar is a different claim from one reading at 80%, and
        // the counts differ accordingly.
        <span>
          Read at each matcher&apos;s own verdicts — no threshold of your own is applied.
        </span>
      ) : (
        <span>
          Every count here is read at{" "}
          <span className="font-medium text-foreground tabular-nums">
            {formatThreshold(threshold)}
          </span>
          , the bar set on Network.{" "}
          {/* The same disclosure the control makes, for the same reason: a reader acting on a
              re-graded count should know they are acting on their own bar, not a matcher's. */}
          <span className="whitespace-nowrap">The stored verdicts are unchanged.</span>
        </span>
      )}
      <Link
        href={withThreshold(changeHref, threshold)}
        className="font-medium text-primary underline-offset-2 hover:underline"
      >
        Change
      </Link>
    </p>
  );
}
