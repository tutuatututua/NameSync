"use client";

import * as React from "react";
import { ALL_SOURCES_LABEL, sourcesLabel, sourcesTooltip } from "@extensions/contract";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Which friends a run covered, as it sits on a finished run.
 *
 * The twin of `CompareModeBadge`, and it renders beside it everywhere, because the two together
 * are the run's question: "Surname · Thai" says how names were compared and this says whose. Either
 * one alone is half a sentence, and the half that goes missing is the one that quietly makes two
 * runs look comparable when they are not.
 *
 * ── IT IS NEVER ABSENT, AND THAT IS THE WHOLE DESIGN ──
 *
 * The tempting version hides the chip when `sources` is null, on the reasoning that "all sources"
 * is the default and defaults do not need saying. That inverts the reading. Once ANY run can be
 * narrowed, the absence of a chip stops meaning "not narrowed" and starts meaning "unlabelled" —
 * and a reader who has seen one run tagged "LinkedIn" will read the untagged run beside it as
 * older, or as broken, or as a different kind of thing. Rendering "All sources" costs one chip and
 * removes the inference entirely.
 *
 * This is the same argument `scoreQualifier` settled on 2026-07-31 when it stopped returning null
 * for whole-name runs, and for the same reason: these things appear side by side in pooled lists,
 * where an omitted qualifier is read as a formatting inconsistency rather than as a value.
 */
export function SourcesBadge({
  sources,
  labels,
  className,
}: {
  /** Null is every source — rendered as "All sources", not hidden. */
  sources: string[] | null;
  /** The `upload_source` labels, when the caller has them. Without them the chip falls back to
   *  title-casing the stored value, which gets 'Facebook' right and 'LinkedIn' slightly wrong. */
  labels?: ReadonlyMap<string, string>;
  className?: string;
}) {
  const isAll = !sources || sources.length === 0;
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 font-normal text-muted-foreground", className)}
      title={sourcesTooltip(sources ?? null, labels)}
    >
      {sourcesLabel(sources ?? null, labels)}
      {/* Marked as the default in the same idiom CompareModeBadge uses for `en_full`, so a reader
          can tell "nobody narrowed this" from "somebody chose everything" — which are the same
          run, but not the same act, and the chip is the record of the act. */}
      {isAll && <span className="text-2xs opacity-70">default</span>}
    </Badge>
  );
}

/** The plain-text form, for places that carry a sentence rather than a chip. */
export const sourcesText = (sources: string[] | null, labels?: ReadonlyMap<string, string>): string =>
  sourcesLabel(sources, labels) || ALL_SOURCES_LABEL;
