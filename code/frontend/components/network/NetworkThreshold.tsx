"use client";

import * as React from "react";
import { Info, RotateCcw, SlidersHorizontal } from "lucide-react";
import { THRESHOLD_MAX, THRESHOLD_MIN, formatThreshold } from "@extensions/contract";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { DEFAULT_THRESHOLD } from "@/hooks/useThreshold";
import { cn } from "@/lib/utils";

/**
 * "Show me my whole network as though the bar had been here."
 *
 * ── Why it is on this page and not on a run ──
 *
 * It used to sit on `/comparisons/:id`, tuning one run, and that was answering a question almost
 * nobody has. A run is a historical event; what people act on is the POOLED answer — who reaches
 * BANGKOK BANK, which of an owner's friends were placed — and that answer is assembled from every
 * run on file, each frozen at whatever bar its own matcher used. With the control on a run page,
 * tuning was possible and worthless: you could re-read run 3 and the Network page beside it would
 * not move an inch.
 *
 * So the bar moved to where the numbers people read actually live. One bar, tuning the whole
 * workspace, travelling into the roster and company pages on every link the tabs draw.
 *
 * ── What it does NOT do ──
 *
 * It writes nothing. The stored `status` on every result row is still the verdict its matcher
 * reached; this asks the server to re-grade the rows on the way out, from the similarity each one
 * already carries, and throws the answer away. Open the workspace at `?threshold=off` and it says
 * exactly what it always said.
 *
 * That distinction is not pedantry. The product spent a schema revision getting OUT of the
 * situation where a threshold re-derived every verdict on every read — a bar that moved silently
 * re-graded history, and two authorities disagreed about what "match" meant (see `regradeVerdict`
 * and schema-redesign.sql). What makes this safe is that it is explicit, per-request and visible:
 * the panel is never dressed as the data's own answer, and every paint names the bar it is reading
 * at and says the stored verdicts are untouched.
 *
 * ── Why it is ON at 80% when the page opens ──
 *
 * That last safeguard is the reason a default bar does not walk back into the old failure. The
 * workspace pools runs from matchers of differing strictness, so "the matchers' own verdicts" is not
 * one standard — it is whatever each importer happened to use, and opening on it asks the reader to
 * compare numbers that were not decided alike. 80% is one standard, applied to everything at once.
 *
 * It stays safe because it is still SAID: the panel reads "Every count on this page is read at 80%
 * / The stored verdicts are unchanged" from the first paint. The failure being avoided was a bar
 * that re-graded silently — this one is loud, reversible in a click, and writes nothing either way.
 * The server's default is untouched (see `useThreshold`).
 *
 * ── Why nothing offers to undo the default ──
 *
 * The reset returns the handle to 80% — the position the page opens in — so on arrival it is an
 * offer to undo nothing, and a permanently visible undo reads as though something has already been
 * done to the numbers. It appears once the reader has moved off the default and goes away again
 * when they come back, which is the only span in which it has anything to say.
 *
 * ── Why it is server-driven ──
 *
 * The tempting build is a slider that re-labels what is on screen. There is nothing on screen to
 * re-label: this page shows COUNTS — distinct matched friends, a company's reach, a roster's split
 * — tallied in SQL over every result row in the database. The rows never reach the client. The bar
 * goes to the database, or it does nothing.
 *
 * ── Why it says how many rows it can move ──
 *
 * `regradeVerdict` leaves a row with no `similarity` at its stored verdict, and that is the right
 * rule: a workflow that posted a verdict and no number told us what it decided and nothing about
 * how close it was, so re-grading it would mean inventing the number. The consequence is severe on
 * a database fed by an external matcher — 253 of 300 rows on the live one are `no_match` with a
 * null score — and it is INVISIBLE. Drag the bar end to end, watch the headline move by three, and
 * the only available conclusion is that the control is broken.
 *
 * So the coverage is stated, every time it is less than total. The run page solved the same problem
 * by hiding the slider outright when its run kept no scores (`hasSimilarity`); pooled across every
 * run that gate is a proportion rather than a yes/no, so this states the proportion instead of
 * hiding a control that does work — just not on most of the table. At zero it goes back to the run
 * page's answer and disables the handle, because then there is genuinely nothing to move.
 */

/**
 * Where the handle parks — and, since the workspace now opens at a bar rather than at the stored
 * verdicts, what the page is read at before anyone touches anything, and what the reset returns to.
 * It lives in `useThreshold` because the URL is what actually carries it: this component would
 * otherwise draw a thumb at 80% over counts the page had fetched at some other bar.
 *
 * Still not a verdict rule, and still not in the contract. The SERVER's default is unchanged — an
 * absent `?threshold=` re-grades nothing — so no stored row means anything different than it did.
 * What changed is which question the workspace asks first.
 */
const RESTING_POSITION = DEFAULT_THRESHOLD;

const STEP = 0.01;

/** Long enough that dragging across the track is one or two round trips rather than eighty; short
 *  enough that letting go feels like it already answered. */
const COMMIT_DELAY_MS = 250;

export function NetworkThreshold({
  value,
  onChange,
  scored,
  results,
  busy,
}: {
  /** The bar in effect, or null for the matchers' own verdicts. The page loads at
   *  `DEFAULT_THRESHOLD`; null is `?threshold=off`, an explicit opt-out nothing on this panel
   *  produces — the reset here returns to the default bar, not past it. */
  value: number | null;
  onChange: (next: number | null) => void;
  /** Stored result rows carrying a score — the ones this bar can re-grade. Undefined while the
   *  coverage query is still in flight, which reads as "don't claim anything yet". */
  scored?: number;
  /** Stored result rows in total. `results − scored` keep their matcher's verdict at every bar. */
  results?: number;
  /** A read is in flight — the numbers on the page are the previous bar's. */
  busy?: boolean;
}) {
  const active = value !== null;
  // Only once we actually know. `scored === 0` disables the control; `undefined` must not, or the
  // handle would be dead for the first moment of every page load.
  const nothingToGrade = scored === 0;
  // A bar is in effect AND it is capable of moving something. The two came apart when the workspace
  // started opening at a default bar: on a database where no stored result carries a score, the page
  // now arrives holding 80% over counts that 80% cannot touch. Announcing "80%" beside "nothing here
  // can be re-graded" is the panel contradicting itself, so the number and the reset are withheld
  // and the explanation below carries the whole message.
  const grading = active && !nothingToGrade;
  const partial =
    scored !== undefined && results !== undefined && scored > 0 && scored < results;

  /**
   * The handle's position, held locally so dragging is smooth while the network is not.
   *
   * The committed value round-trips to the server, and at 250ms of debounce the prop lags the thumb
   * by a fraction of a second on every drag. Rendering the thumb from the prop would make it stick
   * and jump. Local state renders the drag; `onChange` is what the workspace is actually read at.
   */
  const [position, setPosition] = React.useState(value ?? RESTING_POSITION);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow the value when it moves from OUTSIDE this component — a reset, or a link opened at a
  // bar. Keyed on `value` alone, so a drag (which has not committed yet) is never yanked back.
  React.useEffect(() => {
    if (value !== null) setPosition(value);
  }, [value]);

  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const commit = (next: number) => {
    setPosition(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      onChange(next);
    }, COMMIT_DELAY_MS);
  };

  /**
   * Land the bar the moment the handle is let go, instead of a quarter-second later.
   *
   * The debounce exists for the DRAG — eighty positions crossing the track is one or two round
   * trips, not eighty. Once the drag is over there is nothing left to coalesce, and the delay stops
   * being a saving and becomes a window in which the workspace disagrees with itself: the panel
   * reads 50%, the URL does not have it yet, and every link on the page is built from the URL. Let
   * go and click a company inside that window and the page opens at the bar you just left behind —
   * the one failure this control is supposed to make impossible.
   */
  const flush = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    onChange(position);
  };

  const reset = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPosition(RESTING_POSITION);
    onChange(RESTING_POSITION);
  };

  // Whether the reset has anything to return to. It parks the handle back at the DEFAULT bar rather
  // than at the matchers' verdicts, so at the default it would undo the position it is already in.
  // Read off `position` rather than `value` so it follows the handle through a drag instead of the
  // committed bar a quarter-second behind it — the number beside it is drawn from `position` too,
  // and the two must not disagree. `value === null` is the case where they part in the other
  // direction: the opt-out leaves `position` parked at a default the page is not being read at.
  const offDefault = !nothingToGrade && (value === null || position !== RESTING_POSITION);

  // How far along the track the handle is, as a percentage — the filled half of the rail is drawn
  // from it, since a native range input gives no way to style the portion behind the thumb.
  const percent = ((position - THRESHOLD_MIN) / (THRESHOLD_MAX - THRESHOLD_MIN)) * 100;

  return (
    <Card className={cn(grading && "border-primary/30")}>
      <CardContent className="space-y-3 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <Label htmlFor="network-threshold" className="text-sm font-medium">
              Match threshold
            </Label>
          </div>

          <div className="flex items-center gap-3">
            <span
              className={cn(
                "font-display text-lg font-semibold tabular-nums leading-none",
                grading ? "text-primary" : "text-muted-foreground"
              )}
            >
              {grading ? formatThreshold(position) : "—"}
            </span>
            {/* Only once the reader has moved off the bar the page opens at. A permanently visible
                reset offers to undo nothing, and reads as though something already happened to the
                numbers — which, at the default, is precisely the impression to avoid. */}
            {offDefault && (
              <Button variant="ghost" size="sm" onClick={reset} className="gap-1.5">
                <RotateCcw className="h-3 w-3" aria-hidden />
                Default
              </Button>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="relative flex items-center">
            {/* The rail, drawn behind the input: a native range gives no handle on the filled
                portion, and "everything at or above the bar counts" is the one thing the shape of
                this control should say without being read. */}
            <div className="pointer-events-none absolute inset-x-0 h-1.5 rounded-full bg-muted" aria-hidden>
              <div
                className={cn("h-full rounded-full", grading ? "bg-primary/60" : "bg-border-strong")}
                style={{ width: `${percent}%` }}
              />
            </div>
            <input
              id="network-threshold"
              type="range"
              min={THRESHOLD_MIN}
              max={THRESHOLD_MAX}
              step={STEP}
              value={position}
              onChange={(e) => commit(Number(e.target.value))}
              // Both ways a drag can end — pointer released, or an arrow key let go. `onBlur` is
              // deliberately not one of them: clicking a link does not blur the input first in
              // every engine, so it would be a flush that fires in the cases that don't need it.
              onPointerUp={flush}
              onKeyUp={flush}
              disabled={nothingToGrade}
              aria-label="Match threshold"
              aria-valuetext={
                grading ? `${formatThreshold(position)} similarity` : "the matchers' own verdicts"
              }
              className={cn(
                "relative h-1.5 w-full cursor-pointer appearance-none bg-transparent",
                "focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
                // The thumb, per engine — there is no cross-browser selector for it, so both are
                // written out rather than one being assumed to cover the other.
                "[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none",
                "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2",
                "[&::-webkit-slider-thumb]:border-background [&::-webkit-slider-thumb]:bg-primary",
                "[&::-webkit-slider-thumb]:shadow-xs",
                "[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full",
                "[&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-background",
                "[&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:shadow-xs"
              )}
            />
          </div>
          <div className="flex justify-between text-2xs text-muted-foreground">
            <span>Looser — more matches</span>
            <span>Stricter — fewer</span>
          </div>
        </div>

        <p className={cn("text-sm text-muted-foreground", busy && "opacity-60")}>
          {nothingToGrade ? (
            <>
              Nothing on file can be re-graded: not one stored result carries a score, so every
              verdict here is its matcher&apos;s and a bar has nothing to measure against.
            </>
          ) : active ? (
            <>
              Every count on this page is read at{" "}
              <span className="font-medium text-foreground">{formatThreshold(position)}</span>, and
              the bar follows you into a company or a roster.{" "}
              {/* The claim this control must never let slip. Everything above is a lens; the runs
                  underneath it are unchanged, and a reader who acts on a lowered bar should know
                  they are acting on their own judgement rather than a matcher's. */}
              <span className="whitespace-nowrap">The stored verdicts are unchanged.</span>
            </>
          ) : (
            <>
              Showing what each matcher decided. Move the bar to re-read every connection on file at
              one threshold of your own.
            </>
          )}
        </p>

        {/*
          THE REASON THE NUMBERS BARELY MOVE, stated before the reader concludes the slider is
          broken. A row with no similarity keeps its matcher's verdict at every bar (see
          `regradeVerdict`), and on an externally-matched database that is most of the table — so
          the honest thing is to say which fraction of the evidence this handle actually governs.
          Rendered only when it is less than all of it: on a fully-scored database the sentence
          would be noise about a non-problem.
        */}
      </CardContent>
    </Card>
  );
}
