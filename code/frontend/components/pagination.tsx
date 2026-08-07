"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The one way this product turns a page.
 *
 * Every paged list in the app grew its own copy of the same two buttons — Previous and Next, a
 * "Page 3 of 41" beside them — and that was a fair control while the lists were short. It stops
 * being one the moment a run has 320 rows or a database has 800 companies: Previous/Next is a
 * SEQUENTIAL control over a list nobody reads sequentially. Page 27 of 41 is nineteen presses away,
 * the last page is unreachable without counting, and the reader has no way to say the one thing they
 * actually know — "the row I want is about two-thirds down".
 *
 * So the control states where you are and offers every way out of it at once:
 *
 *     Page 12 of 41 · 812 rows        [«] [‹] 7 8 9 10 11 [12] 13 14 15 16 17 [›] [»]  Go to [  ]
 *
 *   · FIRST and LAST (« ») — the two pages that are always worth reaching and were always the
 *     furthest away. "Back to the top of the list" and "how does this end" are both one press.
 *   · The ARROWS (‹ ›) — the old Previous/Next, kept because stepping is still the common move.
 *   · A WINDOW of numbered pages, `WINDOW` either side of the current one, so a reader can jump a
 *     short distance without typing and can see where they are in the run of pages.
 *   · GO TO — a box for the long jump. The window covers ±5; page 27 of 41 from page 3 is a number
 *     you type, and typing it is faster than any number of presses.
 *
 * ── One component, not a pattern to copy ──
 *
 * It is deliberately a component and not a snippet, because the five lists that use it were already
 * five slightly different renderings of one idea (two of them disabled their buttons while fetching,
 * one counted rows in its summary and the others did not, one said "Page 1 of 3" where another said
 * "1 / 3"). A reader who learns to turn a page on the Results tab has learned it for the company
 * list, the roster list and a run's rows.
 *
 * What it does NOT own is the wording of the summary line: "812 rows", "41 companies" and "12
 * comparisons" are facts about the list, and the list is the only thing that knows the noun. Hence
 * `summary` as a node, defaulted to the part that is always true.
 */

/**
 * Rows per page.
 *
 * Twenty, and the same twenty everywhere — the number is only meaningful because it is uniform. A
 * reader who knows that page 4 starts at row 61 on one list should not have to re-learn it on the
 * next, and the run table's 25 was the one holdout.
 */
export const PAGE_SIZE = 20;

/**
 * How many numbered pages sit either side of the current one.
 *
 * Five, so the strip is eleven wide at most — enough to step a short distance by eye, and short
 * enough that it stays a control rather than becoming a second list. Anything further is what the
 * Go to box is for.
 */
const WINDOW = 5;

/**
 * The numbered pages to draw, centred on `page` and clamped to the ends.
 *
 * The strip keeps a CONSTANT WIDTH where the run of pages allows it: at page 1 of 40 it shows 1–11
 * rather than 1–6, so the controls to the right of it do not slide sideways as the reader pages in
 * from the edge. A moving target is the one thing a pager must not be.
 */
export function pageWindow(page: number, totalPages: number, window: number = WINDOW): number[] {
  const span = window * 2 + 1;
  if (totalPages <= span) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const start = Math.min(Math.max(1, page - window), totalPages - span + 1);
  return Array.from({ length: span }, (_, i) => start + i);
}

export function Pager({
  page,
  totalPages,
  onPageChange,
  summary,
  label = "list",
  pending = false,
  disabled = false,
  className,
}: {
  /** The page currently on screen, 1-based. */
  page: number;
  /** How many there are in total. Below 2 this component renders nothing — a pager over a single
   *  page is four disabled buttons and a box that can only be typed the number you are already on. */
  totalPages: number;
  /** Always called with a page inside `1..totalPages` — the clamping is done here rather than in
   *  five callers, so a typed `999` lands on the last page instead of on an empty one. */
  onPageChange: (page: number) => void;
  /**
   * The line to the left of the controls. Defaults to "Page 3 of 41", which is the half that is
   * true of every list; a caller that can also say "· 812 rows" passes the whole sentence, because
   * the noun is its own and pluralising "compan(y|ies)" here would be this component guessing.
   */
  summary?: React.ReactNode;
  /** What the list holds, for the screen-reader label on the nav ("run rows", "companies"). */
  label?: string;
  /**
   * THE PAGE YOU ASKED FOR IS STILL COMING.
   *
   * This is not decoration. Every server-paged list in this app keeps the previous page on screen
   * while the next one is fetched (`keepPreviousData`), which is the right call — a list that blanks
   * on every page turn is unreadable — but it has a failure mode the dim alone does not cover: on a
   * read that takes two or three seconds, pressing "3" changes NOTHING the reader can see for long
   * enough to conclude the button is broken, and press it again. That is exactly what the company
   * page does (its per-row subqueries run 1.5–3s against this database).
   *
   * So the pressed page highlights immediately — it is what was asked for — and the summary says the
   * answer has not arrived yet. Together they read as "heard you, working" rather than as nothing.
   */
  pending?: boolean;
  /** Freeze the controls while a page is in flight. Off by default, and `pending` is usually the
   *  better answer: a reader who wants page 9 should be able to press 9 while page 3 is still in
   *  flight. Reach for this only where a queued request would actually go wrong. */
  disabled?: boolean;
  className?: string;
}) {
  const inputId = React.useId();
  const [draft, setDraft] = React.useState("");

  // The box empties itself once the jump lands, so it never sits there holding a number that is no
  // longer a request. `page` moves for every route into this control, not just for a typed jump.
  React.useEffect(() => setDraft(""), [page]);

  if (totalPages < 2) return null;

  const go = (next: number) => {
    const clamped = Math.min(totalPages, Math.max(1, next));
    if (clamped !== page) onPageChange(clamped);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = Number.parseInt(draft.trim(), 10);
    // A typo is not a navigation. Clearing the box is the whole of the feedback: the page number to
    // the left never moved, which is the honest report of what happened.
    if (Number.isFinite(n)) go(n);
    setDraft("");
  };

  const pages = pageWindow(page, totalPages);

  return (
    <nav
      aria-label={`Pagination for ${label}`}
      aria-busy={pending || undefined}
      className={cn("flex flex-wrap items-center justify-between gap-3", className)}
    >
      <p className="flex items-center gap-2 text-sm tabular-nums text-muted-foreground">
        {summary ?? `Page ${page.toLocaleString()} of ${totalPages.toLocaleString()}`}
        {/* `aria-live` so the wait is announced and not merely drawn — the visual half of this is a
            spinner, which says nothing to a reader who is not looking at it. */}
        {pending && (
          <span className="flex items-center gap-1.5 text-muted-foreground" aria-live="polite">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
            Loading page {page.toLocaleString()}…
          </span>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="outline"
          size="icon-sm"
          disabled={disabled || page <= 1}
          onClick={() => go(1)}
          aria-label="First page"
          title="First page"
        >
          <ChevronsLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          disabled={disabled || page <= 1}
          onClick={() => go(page - 1)}
          aria-label="Previous page"
          title="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        {/* The numbers are the first thing to go on a narrow screen: they are the convenience, and
            the arrows, the ends and the Go to box between them can reach any page without one. */}
        <div className="hidden items-center gap-1 sm:flex">
          {pages.map((n) => {
            const current = n === page;
            return (
              <Button
                key={n}
                variant={current ? "secondary" : "ghost"}
                size="sm"
                disabled={disabled}
                onClick={() => go(n)}
                aria-label={`Page ${n}`}
                aria-current={current ? "page" : undefined}
                className={cn("min-w-8 px-2 tabular-nums", current && "font-semibold text-foreground")}
              >
                {n}
              </Button>
            );
          })}
        </div>

        <Button
          variant="outline"
          size="icon-sm"
          disabled={disabled || page >= totalPages}
          onClick={() => go(page + 1)}
          aria-label="Next page"
          title="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          disabled={disabled || page >= totalPages}
          onClick={() => go(totalPages)}
          aria-label="Last page"
          title="Last page"
        >
          <ChevronsRight className="h-4 w-4" />
        </Button>

        {/* A real form, so Enter submits it the way every reader expects and the label is bound to
            the box rather than sitting beside it. The placeholder is the page you are ON — it says
            what the box takes and what is in effect, in the one character of space available. */}
        <form onSubmit={submit} className="ml-1 flex items-center gap-1.5">
          <label htmlFor={inputId} className="whitespace-nowrap text-xs text-muted-foreground">
            Go to
          </label>
          <Input
            id={inputId}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setDraft("")}
            disabled={disabled}
            inputMode="numeric"
            autoComplete="off"
            placeholder={String(page)}
            aria-label={`Go to page, 1 to ${totalPages}`}
            title={`Type a page between 1 and ${totalPages}, then press Enter`}
            className="h-8 w-14 px-2 text-center text-xs tabular-nums"
          />
        </form>
      </div>
    </nav>
  );
}
