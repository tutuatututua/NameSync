"use client";

import * as React from "react";
import { Building2, FileText, Package, User } from "lucide-react";
import { scopeLabel, scopeTooltip, type FilterBy } from "@extensions/contract";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * WHICH ROWS a run covered, as it sits on a finished run.
 *
 * The third chip, beside `CompareModeBadge` and `SourcesBadge`, and it completes the sentence they
 * were only ever two thirds of. Those two say how names were compared and whose rosters were in
 * play; this says what the run was ASKED about — and until scoped runs existed there was only one
 * possible answer, so not saying it cost nothing. Now "Owner · Alex" and "Company · BlueBrick" can
 * sit one above the other with the same mode and the same sources, and without this chip the only
 * thing telling them apart is a title that truncates.
 *
 * ── IT IS ABSENT WHEN THERE IS NO SCOPE, WHICH IS THE OPPOSITE OF `SourcesBadge` ──
 *
 * That chip renders "All sources" rather than hiding, because null there is one of the answers —
 * a run really did cover every source, and an unlabelled row would be read as older or broken.
 *
 * Null here is not an answer. `comparison.filter_by` is NULL on runs written before the column
 * existed, and there is no fact to render: we do not know what those runs covered, and the two
 * candidates ("everything" and "whatever the import brought") are different runs. A chip reading
 * "All rows" would be a guess wearing the same styling as the three facts beside it — see the
 * migration note on why the column is deliberately not backfilled.
 */
export function ScopeBadge({
  filterBy,
  filterValue,
  axisOnly = false,
  className,
}: {
  /** Null on a run predating the columns — renders nothing. */
  filterBy: FilterBy | null;
  filterValue: string | null;
  /**
   * Print the AXIS alone — "Owner", not "Owner · Nalinee Boonmee".
   *
   * For a caller that has already made the value the heading. A scoped run is auto-named after its
   * own scope (`comparisons.route.ts`), so Results' grouped rows put the subject's name in the
   * title and would otherwise repeat it word for word in the chip directly beneath — the chip's job
   * there is to say what KIND of thing that name is.
   *
   * The tooltip is unaffected: it still spells out the whole scope, so nothing is lost by hovering
   * rather than being lost outright.
   */
  axisOnly?: boolean;
  className?: string;
}) {
  const label = scopeLabel(filterBy, axisOnly ? null : filterValue);
  if (!label || !filterBy) return null;

  const Icon = SCOPE_ICON[filterBy];
  return (
    <Badge
      variant="outline"
      className={cn("max-w-[16rem] gap-1.5 font-normal text-muted-foreground", className)}
      title={scopeTooltip(filterBy, filterValue)}
    >
      <Icon className="h-3 w-3 shrink-0" />
      {/* Truncated, unlike its two neighbours, because this is the only chip whose text is DATA: a
          mode is one of six words and a source list is short, where a company name is whatever a
          customer's export said. Left unbounded, one run with a long employer name would set the
          width of every row in the list. */}
      <span className="truncate">{label}</span>
    </Badge>
  );
}

/**
 * One glyph per axis — the same four the entry points that start these runs are drawn with, so a
 * chip is recognisable as "the thing I pressed" rather than as a fourth vocabulary to learn.
 *
 * `Package` for an import-driven run: it is the only one of the four that nobody chose, and the box
 * reads as "this arrived" rather than as a thing you can point at.
 */
const SCOPE_ICON: Record<FilterBy, typeof Building2> = {
  upload: Package,
  company: Building2,
  owner: User,
  file: FileText,
};
