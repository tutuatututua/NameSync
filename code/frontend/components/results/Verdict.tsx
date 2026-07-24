"use client";

import { Building2, SearchX, Sparkles, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ComparisonProgress, RunRow } from "@extensions/contract";
import { Card, CardContent } from "@/components/ui/card";
import { formatCompanies } from "@/lib/format";
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
}: {
  facts: MergeFacts;
  /** The companies the run was pointed at. Empty for a whole-table run. */
  companies: string[];
  kind: RunRow["kind"];
  origin: ComparisonProgress["origin"];
}) {
  const { matches, scored, contacts, matchedUploaders } = facts;
  const none = matches === 0;

  // What the rows are, and what they were held up against. A company import asks the mirror of the
  // question a friends import asks, and answering both with one sentence is how you get a headline
  // that is true of neither.
  const noun = kind === "company" ? "contact" : "friend";
  // "someone at PTT" becomes "someone at PTT, BANPU or BLUEBIK" — one preposition, one list, and
  // still one claim about each matched friend. "or" and not "and", which would say each of them
  // works at all three.
  const companyLabel = formatCompanies(companies);
  const target =
    kind === "company"
      ? // A friend has no employer on file, so there is no "at X" to offer. What makes a matched
        // contact worth anything is that somebody on your side already knows them.
        "someone you know"
      : companyLabel
        ? `someone at ${companyLabel}`
        : // An import-driven run picked no company: it scored against every contact on file. Saying
          // "the company" here named a company that does not exist, and the page printed that
          // fiction next to rows that named the real one.
          "a contact on file";

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
            {/* The headline is a sentence, not a metric. A number on its own ("13") still
                makes the reader do the work of deciding what it counted. */}
            <h2 className="font-display text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
              {none ? (
                <>
                  No {noun} matches {target}
                </>
              ) : (
                <>
                  <span className="text-primary">
                    {matches.toLocaleString()} {matches === 1 ? noun : `${noun}s`}
                  </span>{" "}
                  {matches === 1 ? "matches" : "match"} {target}
                </>
              )}
            </h2>
            <p className="text-sm text-muted-foreground">
              out of {scored.toLocaleString()} scored ·{" "}
              {/* This used to name the bar — "a match is 80% similarity or better" — which kept
                  the headline honest by admitting the number rested on a threshold the reader
                  could disagree with. There is no threshold on this side any more: the matcher
                  decides, and we store the decision. Saying so is the honest version of the same
                  disclosure, and it is a weaker one, because the reader can no longer check it. */}
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
