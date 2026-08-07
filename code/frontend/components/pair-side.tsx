import * as React from "react";

/**
 * One half of a pairing: whose name this is, then the name.
 *
 * The label is the smallest thing on the row and does the most work on it. Two Thai names either
 * side of an arrow are symmetrical to look at and are not symmetrical at all — one is somebody your
 * team already knows and the other is a stranger at a company you are trying to get into — and
 * which is which is not recoverable from the strings, from the order, or from anything else on the
 * row once the company name wraps to the next line.
 *
 * It rides in front of the name rather than under it so that a wrapped row degrades into two
 * labelled lines instead of two anonymous ones, which is the case the label exists for.
 *
 * ── Why it is shared ──
 *
 * It was private to the run table, and the company page's `ConnectionCard` shipped the same
 * arrow-between-two-names pairing with no labels at all — so the one surface where the reader is
 * deciding whether to ask a colleague for an introduction was the one that never said which of the
 * two names was the person at the company. A reader who cannot tell the sides apart reads the
 * pairing backwards, and a backwards pairing still carries a percentage.
 *
 * Same reasoning as `MarkedName`: two implementations of "which side is which" would be two
 * vocabularies for one distinction, and the labels are the distinction. There is one, here.
 */
export function Side({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5">
      <span
        className="shrink-0 text-2xs uppercase tracking-wide text-muted-foreground/70"
        title={hint}
      >
        {label}
      </span>
      {children}
    </span>
  );
}
