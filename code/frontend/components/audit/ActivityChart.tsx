"use client";

import * as React from "react";
import type { AuditDay } from "@extensions/contract";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Runs and imports per day — the "run count statistic" as a shape rather than a number.
 *
 * ── THE FORM ──
 *
 * Two distinct series over time, and the reader's job is to tell them apart and see the total, so
 * this is a STACKED COLUMN with a categorical palette, not a line and not two charts. `chart-1` is
 * always runs and `chart-2` always imports — fixed, and never reassigned by which is larger, so
 * changing the window cannot repaint the series.
 *
 * ── WHY EVERY DAY IS DRAWN, INCLUDING THE EMPTY ONES ──
 *
 * The API fills the series (`AuditModel.timeline`), so a day with nothing in it arrives as a zero
 * rather than as a missing row. Dropping empty days would compress a quiet fortnight into a narrow
 * gap and make the month read as busier than it was — the axis would stop being time.
 *
 * ── ONE AXIS, AND NO GRIDLINES ──
 *
 * Both series count events, so they share a scale and a baseline; there is no second axis and there
 * will not be one. The peak is direct-labelled and the ends of the range are named under the axis,
 * which between them carry what a gridline would have said at a fraction of the ink.
 */

/** Columns cap at 24px and the band's leftover is air — a bar that fills its slot turns the gaps
 *  between days into the thing you see. */
const MAX_COLUMN_PX = 24;

/** The surface gap between the two stacked segments. White does the separating; a stroke around a
 *  segment would add ink that is not data. */
const SEGMENT_GAP_PX = 2;

export function ActivityChart({
  days,
  windowDays,
  isLoading,
  className,
}: {
  days: AuditDay[];
  windowDays: number;
  isLoading?: boolean;
  className?: string;
}) {
  const [hover, setHover] = React.useState<number | null>(null);

  const totals = days.map((d) => d.runs + d.imports);
  const peak = Math.max(1, ...totals);
  const runs = days.reduce((n, d) => n + d.runs, 0);
  const imports = days.reduce((n, d) => n + d.imports, 0);
  // The busiest day, for the one direct label this chart carries. First of any tie, so a redraw
  // cannot move the label between two identical columns.
  const peakIndex = totals.indexOf(peak);
  const anything = runs + imports > 0;

  if (isLoading) return <Skeleton className={cn("h-[196px] rounded-lg", className)} />;

  return (
    <div className={cn("space-y-3", className)}>
      {/* A legend is always present for two series — identity must never rest on colour alone. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <LegendKey className="bg-chart-1" label="Runs" value={runs} />
        <LegendKey className="bg-chart-2" label="Imports" value={imports} />
      </div>

      <div
        className="relative flex h-[132px] items-end gap-px"
        role="img"
        aria-label={`Activity over the last ${windowDays} days: ${runs} runs and ${imports} imports.`}
        onMouseLeave={() => setHover(null)}
      >
        {days.map((day, i) => {
          const total = day.runs + day.imports;
          // Heights are a share of the peak column, and the two segments split that share by their
          // own counts — so the stack's height is the day's total and each part is its own count.
          const columnPct = total === 0 ? 0 : (total / peak) * 100;
          const runsPct = total === 0 ? 0 : (day.runs / total) * 100;

          return (
            <div
              key={day.date}
              className="group relative flex h-full flex-1 cursor-default flex-col justify-end"
              style={{ maxWidth: MAX_COLUMN_PX }}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              tabIndex={-1}
            >
              {/* The hit target is the whole column height, not the bar: on a quiet day the bar is
                  two pixels tall and would be impossible to hover. */}
              <div
                className={cn(
                  "absolute inset-x-0 inset-y-0 rounded-sm transition-colors",
                  hover === i && "bg-accent/70"
                )}
                aria-hidden
              />

              {total === 0 ? (
                // A zero is drawn as a hairline on the baseline rather than as nothing, so an empty
                // day is visibly a day rather than a hole in the axis.
                <div className="relative h-px w-full rounded-full bg-border" aria-hidden />
              ) : (
                <div
                  className="relative flex w-full flex-col justify-end"
                  style={{ height: `${columnPct}%`, minHeight: 3 }}
                  aria-hidden
                >
                  {day.imports > 0 && (
                    <div
                      // 4px rounded data-end, square where it meets the segment below it.
                      className="w-full shrink-0 rounded-t bg-chart-2"
                      style={{
                        height: `${100 - runsPct}%`,
                        marginBottom: day.runs > 0 ? SEGMENT_GAP_PX : 0,
                      }}
                    />
                  )}
                  <div
                    className={cn(
                      "w-full shrink-0 bg-chart-1",
                      // Square at the baseline; rounded on top only when it is the top of the stack.
                      day.imports > 0 ? "rounded-none" : "rounded-t"
                    )}
                    style={{ height: day.imports > 0 ? `${runsPct}%` : "100%" }}
                  />
                </div>
              )}

              {/* Label the extreme, and only it — a number on every column is chaos and goes
                  unread. Suppressed while a column is hovered so it cannot collide with the
                  tooltip that has just replaced it. */}
              {i === peakIndex && anything && hover === null && (
                <span className="pointer-events-none absolute inset-x-0 -top-4 text-center text-2xs font-medium tabular-nums text-muted-foreground">
                  {peak}
                </span>
              )}

              {hover === i && <DayTooltip day={day} atStart={i < days.length / 2} />}
            </div>
          );
        })}
      </div>

      {/* The axis ends, named. Cheaper than ticks and it says the one thing ticks would: what
          stretch of time this is. */}
      <div className="flex items-center justify-between text-2xs tabular-nums text-muted-foreground">
        <span>{dayLabel(days[0]?.date)}</span>
        <span>{dayLabel(days[days.length - 1]?.date)}</span>
      </div>
    </div>
  );
}

/** A swatch plus text in a text token — the mark carries identity, never the words. */
function LegendKey({ className, label, value }: { className: string; label: string; value: number }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("h-2 w-2 shrink-0 rounded-sm", className)} aria-hidden />
      {label}
      <span className="font-medium tabular-nums text-foreground">{value.toLocaleString()}</span>
    </span>
  );
}

/**
 * The per-column readout. An HTML chart is interactive by nature, and the tooltip is what carries
 * the values the single direct label deliberately leaves off.
 *
 * `atStart` flips the anchor at the halfway mark so a tooltip near the right edge opens leftwards
 * instead of off the card.
 */
function DayTooltip({ day, atStart }: { day: AuditDay; atStart: boolean }) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute bottom-full z-20 mb-1.5 w-max rounded-md border bg-popover px-2 py-1.5 text-popover-foreground shadow-md",
        atStart ? "left-0" : "right-0"
      )}
      role="status"
    >
      <p className="text-2xs font-medium">{dayLabel(day.date, true)}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
        <span className="h-2 w-2 rounded-sm bg-chart-1" aria-hidden />
        Runs
        <span className="tabular-nums text-foreground">{day.runs}</span>
      </p>
      <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <span className="h-2 w-2 rounded-sm bg-chart-2" aria-hidden />
        Imports
        <span className="tabular-nums text-foreground">{day.imports}</span>
      </p>
    </div>
  );
}

/**
 * `YYYY-MM-DD` as a short date, read as UTC.
 *
 * `new Date('2026-08-04')` parses as UTC midnight and `toLocaleDateString` then renders it in the
 * reader's zone — which west of Greenwich is the day before, so every label would be off by one.
 * Formatting in UTC keeps the label on the bucket the server actually counted.
 */
function dayLabel(date: string | undefined, withYear = false): string {
  if (!date) return "";
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
}
