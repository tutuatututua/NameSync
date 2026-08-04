import { formatSimilarity } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A similarity, as a percent tinted by how good it is — red at 0%, green at 100%.
 *
 * ONE CHIP, ONE SHAPE, ON EVERY ROW. The only thing that varies is the hue, and the hue is the
 * measurement. Nothing here encodes what the matcher concluded.
 *
 * ── The verdict used to live in this component, twice, and is now gone (2026-07-31) ──
 *
 * The history is worth keeping, because it is three attempts at the same bad premise:
 *
 *   1. A `Match` / `No match` pill beside the number. Removed as redundant — it announced which
 *      side of the matcher's bar the percent next to it fell on.
 *   2. FILL. A filled chip meant a pairing the matcher stood behind, a bare number one it turned
 *      down. It failed on first contact with a reader, who asked why some scores had a green box
 *      and some did not. Twenty-one identical-looking `surname 100%`s, six of them boxed, is not a
 *      shape you decode; it is a shape you assume is a rendering bug.
 *   3. The word back under the chip, on the argument that score and verdict genuinely disagree and
 *      the disagreement was the most important thing on the row.
 *
 * What each attempt was defending is a real fact: on run 4 of the live database, 21 rows score 100%
 * and only six are matches — `pornthip osathanon` against `วิไล โอสถานนท์` on a SURNAME run is a
 * truthful 100% between two plainly different people. But that fact is a property of the MODE, not
 * of the row: on a surname run every high score means "same family name, verify the person", and
 * saying so once above the list is the honest version. Saying it per row cost a second visual
 * channel, forced two layouts, and made fifty rows of one kind of finding look like two kinds.
 *
 * So the score is now the whole of what a row asserts, and the reader draws their own line. The
 * matcher's verdict has not been deleted from the product — it still drives the filter tabs, the
 * headline count, and the `ask <owner>` action — it is simply not a per-row decoration any more.
 *
 * The QUALIFIER stays, and carries the weight the fill was carrying badly: on a partial run it is
 * the difference between "this is the same person" and "these two surnames are spelled the same".
 * See `scoreQualifier`.
 *
 * ── Why tiers and not a continuous hue ──
 *
 * The literal reading of "0% red, 100% green" is `hsl(value * 140, …)`, and it looks wrong in
 * practice: the middle of that sweep is pure yellow, which fails contrast on a light background,
 * and it would be the one colour in the app not drawn from the theme. These four steps ARE the
 * theme's — `--confidence-low/medium/good/high`, already tuned for both light and dark — so a score
 * here and a graded badge two screens over agree about what "good" looks like.
 *
 * ── The colour is never the ONLY signal ──
 *
 * Nobody should have to distinguish a hue to read this table. The number itself is the fact and the
 * chip carries a `title` spelling the tier out in words. Colour is the second telling, not the
 * first — which matters more now than it did, since it is the only channel left that varies.
 */

/** The four steps, worst first. Each bound is the score at which the tier BEGINS. */
const TIERS = [
  { from: 0.85, tone: "confidence-high", label: "very close" },
  { from: 0.65, tone: "confidence-good", label: "close" },
  { from: 0.4, tone: "confidence-medium", label: "distant" },
  { from: 0, tone: "confidence-low", label: "very distant" },
] as const;

/**
 * Written out rather than interpolated: Tailwind reads class names statically, so a
 * `text-${tone}` compiles to nothing at all and the column renders unstyled.
 *
 * ONE treatment per tier, where there used to be two. The second was the fill that encoded the
 * verdict, and a `Record<tone, {matched, rejected}>` is what made two layouts cheap enough to keep
 * reaching for — flattening it is most of what stops them coming back.
 */
const TIER_CLASS: Record<string, string> = {
  "confidence-high": "border-confidence-high/25 bg-confidence-high/10 text-confidence-high",
  "confidence-good": "border-confidence-good/25 bg-confidence-good/10 text-confidence-good",
  "confidence-medium": "border-confidence-medium/25 bg-confidence-medium/10 text-confidence-medium",
  "confidence-low": "border-confidence-low/25 bg-confidence-low/10 text-confidence-low",
};

const tierFor = (value: number) => TIERS.find((t) => value >= t.from) ?? TIERS[TIERS.length - 1];

/**
 * One score, tinted by how good it is. Identical in shape on every row — see the file header.
 *
 * @param value in [0, 1], or null when the matcher recorded none. A null renders as a muted dash —
 * NOT as 0%, which would colour a missing measurement bright red and read as a confident finding of
 * "nothing in common".
 * @param qualifier what was actually measured (`scoreQualifier`) — `full name`, `given name` or
 * `surname`, optionally with the language. It is the difference between "100% — the same person"
 * and "100% — the same surname", so it is a REQUIRED prop: a component that let a caller forget it
 * would render the two identically.
 *
 * Required, but nullable, and the null has EXACTLY ONE legitimate caller: a row whose own recorded
 * evidence contradicts the mode it was run under, where the unit is genuinely unknown. Passing null
 * because the mode was inconvenient to look up is the bug this prop exists to prevent — it was
 * optional once, defaulting to "no unit on a whole-name run", and the result was unlabelled percents
 * sitting beside labelled ones with nothing to say which was which.
 *
 * The distinction is worth the awkwardness: "we did not label this" and "we cannot label this" are
 * different statements, and only the second is honest about a row an external workflow wrote against
 * a mode it ignored. See `ConnectionCard`, which is the only place that passes null.
 */
export function Score({
  value,
  qualifier,
  className,
}: {
  value: number | null | undefined;
  qualifier: string | null;
  className?: string;
}) {
  const text = formatSimilarity(value);

  if (text === null) {
    return (
      <span
        className={cn("tabular-nums text-sm text-muted-foreground", className)}
        title="This matcher recorded no score for the row."
      >
        —
      </span>
    );
  }

  // Clamped for the same reason `formatSimilarity` clamps the text: an external matcher writes this
  // column, and a 1.4 must not fall off the end of the tier list and render untinted.
  const tier = tierFor(Math.min(Math.max(value as number, 0), 1));

  /*
   * The sentence a hover gets — the tier in words, so the hue is never the only way to read the
   * chip. It describes the MEASUREMENT and stops there: "a very close surname match at 100%" is
   * everything this component knows, and what to do about it is the reader's call.
   *
   * With no unit it can only describe the number, and says so rather than filling the gap with the
   * run's settings. The caller that passes null is the one place where those settings are known to
   * be wrong about the row.
   */
  const title = qualifier
    ? `A ${tier.label} ${qualifier} match at ${text}.`
    : `${text}. What this score measured was not recorded for this row.`;

  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-sm font-medium tabular-nums",
        TIER_CLASS[tier.tone],
        className
      )}
      title={title}
    >
      {qualifier ? `${qualifier} ${text}` : text}
    </span>
  );
}
