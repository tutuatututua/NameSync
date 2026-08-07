"use client";

import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * A part-to-whole ratio over every run on file — "how much of our matching is Thai", "how much
 * rests on a surname alone".
 *
 * ── A DONUT, NOT A FILLED PIE ──
 *
 * The hole is not decoration: it is where the total goes. A filled pie has nowhere to put "43 runs"
 * except outside the chart, and the ratio is close to meaningless without it — 70% Thai across four
 * runs and across four hundred are very different claims. The centre also gives the slice labels a
 * place to sit that is not on top of the marks.
 *
 * ── WHAT IT IS AND IS NOT FOR ──
 *
 * Part-to-whole AT A GLANCE, at most a handful of segments. It is deliberately not the thing to
 * read a close comparison off — two slices at 34% and 31% are indistinguishable as arcs, which is
 * why every segment is also direct-labelled with its own percentage and count in the legend beside
 * it. The arcs carry the shape; the legend carries the values. Neither is decoration for the other.
 *
 * ── COLOUR ──
 *
 * Categorical, in the fixed `chart-1..3` order, assigned by the segment's own identity (English is
 * always slot 1, Thai always slot 2) and never by size. A ratio that flipped its colours when Thai
 * overtook English would make two screenshots of the same chart uncomparable. The three tokens are
 * validated as a three-slot palette in both themes — see globals.css.
 */

export interface DonutSegment {
  key: string;
  label: string;
  value: number;
}

/** Slot order is fixed and positional — the Nth segment always wears the Nth token. */
const SLOT = ["bg-chart-1", "bg-chart-2", "bg-chart-3"] as const;
const STROKE = ["hsl(var(--chart-1))", "hsl(var(--chart-2))", "hsl(var(--chart-3))"] as const;

/** Geometry. A thin ring — a fat one is a pie with a dot in it and reads much heavier. */
const SIZE = 132;
const STROKE_WIDTH = 16;
const RADIUS = (SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * The 2px surface gap the mark specs require between touching fills, expressed in arc length.
 *
 * Applied by shortening every segment's dash rather than by drawing a stroke between them: a
 * border around a mark is ink that is not data, where a gap is the surface showing through.
 */
const GAP_PX = 2;

export function RunMixDonut({
  title,
  segments,
  total,
  totalLabel,
  isLoading,
  emptyLabel = "No runs yet",
  className,
}: {
  title: string;
  segments: DonutSegment[];
  /** The denominator, stated in the hole. Passed in rather than summed, so a caller whose
   *  segments are a subset cannot silently report the subset as the whole. */
  total: number;
  totalLabel: string;
  isLoading?: boolean;
  emptyLabel?: string;
  className?: string;
}) {
  if (isLoading) {
    return (
      <div className={cn("space-y-3", className)}>
        <Skeleton className="h-4 w-24" />
        <div className="flex items-center gap-5">
          <Skeleton className="h-[132px] w-[132px] shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      <p className="text-xs font-medium text-muted-foreground">{title}</p>

      {total === 0 ? (
        // No runs at all. A ring of nothing would read as a chart that failed to load, and there is
        // no ratio to state — 0 of 0 is not 0%.
        <p className="py-6 text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-4">
          <Ring segments={segments} total={total} totalLabel={totalLabel} />

          {/* The legend is the value channel — identity never rests on colour alone, and an arc
              cannot be read to a percentage point. Always present: two segments is already ≥ 2
              series. */}
          <ul className="min-w-[9rem] flex-1 space-y-1.5">
            {segments.map((seg, i) => (
              <li key={seg.key} className="flex items-baseline gap-2 text-sm">
                <span
                  className={cn("mt-1 h-2 w-2 shrink-0 rounded-sm", SLOT[i % SLOT.length])}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{seg.label}</span>
                <span className="shrink-0 font-medium tabular-nums">{percent(seg.value, total)}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {seg.value.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Ring({
  segments,
  total,
  totalLabel,
}: {
  segments: DonutSegment[];
  total: number;
  totalLabel: string;
}) {
  // Only non-zero segments get an arc. A zero-length dash still renders its linecap as a dot on
  // the ring, which is a slice that does not exist.
  const drawn = segments
    .map((seg, i) => ({ ...seg, slot: i }))
    .filter((seg) => seg.value > 0);

  // With one non-zero segment there is nothing to separate, and a gap would open a notch in what
  // is really a solid ring.
  const gap = drawn.length > 1 ? GAP_PX : 0;

  let offset = 0;
  const arcs = drawn.map((seg) => {
    const length = (seg.value / total) * CIRCUMFERENCE;
    const arc = {
      key: seg.key,
      slot: seg.slot,
      // Never below zero: a segment thinner than the gap would otherwise get a negative dash and
      // render as the full circle.
      dash: Math.max(length - gap, 0.5),
      offset,
    };
    offset += length;
    return arc;
  });

  return (
    <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={`${totalLabel}: ${segments
          .map((s) => `${s.label} ${percent(s.value, total)}`)
          .join(", ")}.`}
      >
        {/* Rotated so the first segment starts at twelve o'clock, which is where a reader starts. */}
        <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
          {/* The track. One step off the surface, so a ring with a single segment still reads as a
              ring rather than as a floating arc. */}
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="hsl(var(--muted))"
            strokeWidth={STROKE_WIDTH}
          />
          {arcs.map((arc) => (
            <circle
              key={arc.key}
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke={STROKE[arc.slot % STROKE.length]}
              strokeWidth={STROKE_WIDTH}
              strokeDasharray={`${arc.dash} ${CIRCUMFERENCE - arc.dash}`}
              strokeDashoffset={-arc.offset}
            />
          ))}
        </g>
      </svg>

      {/* The total, in the hole — the denominator every percentage in the legend is a share OF.
          Proportional figures, not tabular: this is a standalone display number. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-2xl font-semibold leading-none tracking-tight">
          {total.toLocaleString()}
        </span>
        <span className="mt-0.5 text-2xs text-muted-foreground">{totalLabel}</span>
      </div>
    </div>
  );
}

/**
 * A share, as a whole-number percent.
 *
 * Whole numbers because the reader is comparing arcs, and a decimal claims a precision the ring
 * cannot show. Rounding can leave the column summing to 99 or 101; that is the honest cost of
 * rounding each independently, and the counts beside them are exact.
 */
function percent(value: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}
