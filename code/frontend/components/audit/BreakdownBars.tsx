"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * A ranked magnitude comparison — "how many runs used Thai", "how many used surnames".
 *
 * ── THE FORM ──
 *
 * Horizontal bars, because the categories have names and names read horizontally: "Full name",
 * "Business card" and `th_surname` would all need turning on their side under a column chart.
 *
 * ── ONE SERIES, SO ONE HUE AND NO LEGEND ──
 *
 * Every bar here counts the same thing (runs), so the bar's colour carries no identity — the LENGTH
 * is the whole encoding and the label beside it says which row is which. A categorical palette
 * would be inventing a distinction the data does not have, and a legend box with one swatch would
 * restate the section heading.
 *
 * ── ZEROS ARE ROWS ──
 *
 * A mode nobody has ever run is the answer to a question the reader came with, so it gets a row and
 * a "0" rather than being filtered out. It is drawn as a hairline on the axis, not as nothing, so
 * the row is visibly empty rather than looking unrendered.
 */

export interface BreakdownRow {
  key: string;
  label: string;
  value: number;
  /** The muted line under the label — a second fact about the row, never a second bar. */
  hint?: string;
}

export function BreakdownBars({
  rows,
  isLoading,
  emptyLabel = "Nothing yet",
  className,
}: {
  rows: BreakdownRow[];
  isLoading?: boolean;
  emptyLabel?: string;
  className?: string;
}) {
  if (isLoading) {
    return (
      <div className={cn("space-y-2.5", className)}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[34px] rounded" />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return <p className={cn("py-3 text-sm text-muted-foreground", className)}>{emptyLabel}</p>;
  }

  // Scaled to the biggest bar rather than to the total: these are counts against each other, not
  // parts of a whole, and dividing by the sum would leave every bar short on a breakdown with many
  // rows — the reader would read "few" where the answer is "spread out".
  const peak = Math.max(1, ...rows.map((r) => r.value));

  return (
    <ul className={cn("space-y-2.5", className)}>
      {rows.map((row) => (
        <li key={row.key} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-sm">
              {row.label}
              {row.hint && (
                <span className="ml-1.5 text-xs text-muted-foreground">{row.hint}</span>
              )}
            </span>
            {/* Value at the tip of the bar, in a text token. Tabular here — these are a column of
                numbers and have to align down the right edge. */}
            <span className="shrink-0 text-sm font-medium tabular-nums">
              {row.value.toLocaleString()}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
            <div
              className="h-full rounded-full bg-chart-1"
              // minWidth keeps a 1-of-400 bar visible instead of rounding it out of existence; a
              // zero gets nothing, because "none" and "almost none" are different answers.
              style={{
                width: row.value === 0 ? 0 : `${Math.max((row.value / peak) * 100, 1.5)}%`,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
