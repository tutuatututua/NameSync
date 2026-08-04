"use client";

import { Building2, SearchX, Sparkles, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  DEFAULT_COMPARE_BY,
  type CompareBy,
  type ComparisonProgress,
  type RunRow,
} from "@extensions/contract";
import { Card, CardContent } from "@/components/ui/card";
import { CompareModeBadge } from "@/components/compare-mode";
import type { MergeFacts } from "@/lib/match";
import { cn } from "@/lib/utils";

/**
 * The answer to the question the user actually asked.
 *
 * A run scores a whole population and keeps each row's closest counterpart, so its output is the
 * population — in a typical run 90%+ of the rows are strangers at single-digit scores. This page
 * used to open on statistics computed over that population: "Mean similarity 16%", "Lowest 0%".
 * Both are true, both are about the strangers, and neither is the finding. A run that turned up
 * twelve near-certain colleagues and one that turned up nothing look nearly identical through them.
 *
 * So the page opens on the finding instead: how many names matched, out of how many scored.
 * Everything under it — the merge picture, the table — is evidence for this sentence.
 *
 * Every noun in that sentence depends on which way round the run is, which this used to assume:
 * it said "N friends match someone at the company" over a *company* import, where each row is a
 * contact and the thing it matched is a friend. That is not a wording nit — it is the sentence the
 * whole page is built to support, printed backwards.
 */
export function Verdict({
  facts,
  companies,
  kind,
  origin,
  compareBy = DEFAULT_COMPARE_BY,
  unscored = 0,
}: {
  facts: MergeFacts;
  /** The companies the run was pointed at. Empty for a whole-table run. */
  companies: string[];
  kind: RunRow["kind"];
  origin: ComparisonProgress["origin"];
  /** How this run compared. Shown beside the headline because the headline is a count, and a
   *  count of last-name Thai matches is not the same finding as a count of full-name English
   *  ones — two runs of this page put side by side would otherwise look directly comparable. */
  compareBy?: CompareBy;
  /** Rows the mode ruled out. Stated here so "12 of 40" is never read as "12 of everything". */
  unscored?: number;
}) {
  const { matches, scored, contacts, matchedUploaders } = facts;
  const none = matches === 0;

  // What the rows are. Still needed below, where a run that matched nobody explains that every row
  // has a closest counterpart — a sentence that has to know whether those rows are contacts or
  // friends.
  //
  // The `target` that used to sit beside it ("someone you know", "someone at PTT or BANPU") went
  // with the sentence-shaped headline. The run's scope is not lost with it: the page header names
  // the companies, and every matched row names the company it landed at.
  const noun = kind === "company" ? "contact" : "friend";

  /**
   * A supporting number earns its place by saying something the headline does not.
   *
   * These used to render unconditionally, and they were designed for the run this page was designed
   * for: 13 matches out of 320. At 1 of 2 they degenerate into the headline wearing several hats —
   * "1 friend matches…", and beside it 1 contact, 1 owner. Three ways of printing the number 1,
   * which reads as three findings until you stop and check.
   *
   * So each is gated on the thing that makes it informative:
   *
   *   · contacts — only when several matches point at the same contact, which is the only case
   *     where the count differs from the headline. (And never on a company import, where the
   *     matched rows *are* the contacts.)
   *   · relationship owners — only when there are several. "1 relationship owner with a connection"
   *     on a single-owner database is not a fact about the run, it is a fact about the database.
   *
   * A "near-certain" count sat at the top of this list until `matching_score` was dropped. It
   * counted matches in the ≥90% tier, and there are no tiers now — a row records that it matched,
   * not how well, so the strongest thing this page can say about a match is that there is one.
   *
   * When none qualify the block disappears, and the verdict is one sentence — which on a two-row
   * run is the whole truth and all of it.
   */
  const supporting: FactProps[] = [];

  if (!none) {
    if (kind === "facebook" && contacts !== matches) {
      supporting.push({
        icon: Building2,
        value: contacts,
        label: contacts === 1 ? "contact" : "contacts",
        // "at the company" is a sentence with a singular in it, and a run can name three. The
        // caption has to describe the *set* the contacts were drawn from, not assume it is one.
        hint:
          companies.length === 1
            ? "at the company"
            : companies.length > 1
              ? `across ${companies.length} companies`
              : "on file",
      });
    }

    if (matchedUploaders > 1) {
      supporting.push({
        icon: Users,
        value: matchedUploaders,
        label: "relationship owners",
        hint: "with a connection",
      });
    }
  }

  return (
    <Card className={cn(!none && "border-confidence-high/30")}>
      <CardContent className="flex flex-col gap-6 p-5 sm:p-6 lg:flex-row lg:items-center lg:justify-between lg:gap-8">
        <div className="flex items-start gap-4">
          <span
            className={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl shadow-xs",
              none
                ? "border bg-muted text-muted-foreground"
                : "bg-gradient-brand text-white"
            )}
          >
            {none ? (
              <SearchX className="h-5 w-5" aria-hidden />
            ) : (
              <Sparkles className="h-5 w-5" aria-hidden />
            )}
          </span>

          <div className="min-w-0 space-y-1">
            {/* The count, and nothing else.
                This was a full sentence — "4 contacts match someone you know" — on the reasoning
                that a bare number leaves the reader working out what it counted. What changed is
                that the number no longer stands alone: the mode badge, the "out of N scored" line
                directly beneath, and the table's own "Matches 4" tab all say what population it
                came from, so the sentence was the fourth telling rather than the only one. */}
            <h2 className="font-display text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
              {none ? (
                "No match"
              ) : (
                <>
                  <span className="text-primary">{matches.toLocaleString()}</span> match
                </>
              )}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <CompareModeBadge mode={compareBy} />
              {/* A "read at 0.62" badge sat here while this page had a threshold slider, to stop a
                  re-graded count being screenshotted as the run's own finding. The slider moved to
                  the Network page and this count is the matcher's again, unconditionally — so the
                  caption below can state that plainly rather than switching on a bar. */}
              {/* The denominator's missing half. Without it "12 of 40" reads as a 30% hit rate
                  over everything on file, when 280 names were never in the running. */}
              {unscored > 0 && (
                <span className="text-xs text-muted-foreground">
                  {unscored.toLocaleString()} not compared
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              out of {scored.toLocaleString()} scored ·{" "}
              {/* This used to name the bar — "a match is 80% similarity or better" — which kept
                  the headline honest by admitting the number rested on a threshold the reader
                  could disagree with. There is no threshold on this side any more: the matcher
                  decides, and we store the decision. Saying so is the honest version of the same
                  disclosure, and it is a weaker one, because the reader can no longer check it —
                  what they CAN do is re-read the pooled answer at a bar of their own, on the
                  Network page. */}
              <span className="whitespace-nowrap">as decided by the matcher</span>
            </p>
          </div>
        </div>

        {none ? (
          <p className="max-w-sm shrink-0 text-sm text-muted-foreground lg:text-right">
            {/* Two different facts, and they used to be told as one. A compare scores every name
                and keeps its closest counterpart, so a "no matches" run genuinely has a nearest
                miss for each row. An import-driven run does not: the workflow writes a result only
                for a row it matched, so its unmatched rows have no score at all — promising a
                closest contact there sends the reader looking for a number that was never taken. */}
            {origin === "compare" ? (
              <>
                Every {noun} still has a closest counterpart — they are all just too distant to call
                the same person. The table below has them, worst included.
              </>
            ) : (
              <>
                The matcher compared every name it was given and found nobody close enough. They are
                all in the table below.
              </>
            )}
          </p>
        ) : (
          supporting.length > 0 && (
            <dl
              className={cn("grid shrink-0 gap-x-6 gap-y-1 sm:gap-x-8", GRID_COLS[supporting.length])}
            >
              {supporting.map((f) => (
                <Fact key={f.label} {...f} />
              ))}
            </dl>
          )
        )}
      </CardContent>
    </Card>
  );
}

interface FactProps {
  icon: LucideIcon;
  value: number;
  label: string;
  hint: string;
  emphasis?: boolean;
}

/** Written out, not interpolated — Tailwind reads these class names statically, so a
 *  `grid-cols-${n}` would compile to nothing at all. */
const GRID_COLS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
};

/** One supporting number. Tabular figures — these sit in a row and have to line up. */
function Fact({ icon: Icon, value, label, hint, emphasis }: FactProps) {
  return (
    <div className="space-y-0.5">
      <dd
        className={cn(
          "font-display text-2xl font-semibold leading-none tabular-nums tracking-tight",
          emphasis ? "text-confidence-high" : "text-foreground"
        )}
      >
        {value.toLocaleString()}
      </dd>
      <dt className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" aria-hidden />
        {label}
      </dt>
      <p className="text-2xs text-muted-foreground/70">{hint}</p>
    </div>
  );
}
