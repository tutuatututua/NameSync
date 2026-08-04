"use client";

import * as React from "react";
import Link from "next/link";
import { UploadCloud, Users } from "lucide-react";
import type { ComparisonProgress, ComparisonResultRow } from "@extensions/contract";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { Verdict } from "@/components/results/Verdict";
import { RunRows } from "@/components/results/RunRows";
import { formatCompanies } from "@/lib/format";
import { fromResultRow, summarize } from "@/lib/match";

/**
 * A run: what it found, and the rows behind it. Two things, in that order.
 *
 * It was four, and the shrinking is the point — every removal was a thing that existed to
 * compensate for a table that has since been fixed:
 *
 *   · Four stat tiles (Friends scored / Mean similarity / Lowest / Highest). Three of them were
 *     statistics over a population that is mostly strangers, so they measured the noise, and two
 *     runs with wildly different findings read almost identically through them.
 *   · `MatchTable`, which read `comparison_result` — only the rows that *matched*, on an import.
 *     So the page showed a table of winners and then a second table with every row in it: the same
 *     matches twice, the second carrying strictly more. One table now, fed from wherever this run's
 *     rows physically live.
 *   · `MergeSummary`, a legend explaining that a row is two records fused by a score. It was right
 *     about `MatchTable`, which put a Facebook name and a company name in adjacent columns with
 *     nothing marking the seam. The table below marks it: the columns are headed "Friend" and
 *     "Matched contact", and each half carries its own provenance — the uploader under the friend,
 *     the company under the contact. A legend for a picture that labels itself is just a second
 *     copy of the counts, and that is all it had become.
 *
 * What is left is the finding and the evidence for it.
 *
 * `results` is still fetched, and is still only the matches — but nothing here paginates it. It
 * feeds the aggregate facts beside the headline, and every one of those is a fact *about the
 * matches*, which is exactly what it holds in every kind of run.
 */
export function ResultsView({
  comparisonId,
  results,
  scoredCount,
  selectedCompanies = [],
  progress,
  live,
}: {
  comparisonId: string;
  results: ComparisonResultRow[];
  /** How many names the run looked at. See ResultsData.scoredCount — with the external
   *  matcher this is larger than `results.length`, because a workflow only writes back the
   *  rows that matched. */
  scoredCount?: number;
  /** The companies the run was pointed at. Empty for a whole-table run — an import scores against
   *  everything on file, not against companies anyone picked. */
  selectedCompanies?: string[];
  /** Which way round the run is, what it has decided so far, and the extra columns it sent.
   *  Undefined only on the first frame, before the poll lands. */
  progress?: ComparisonProgress;
  /** Keep polling the rows. False for a run that has stopped moving. */
  live: boolean;
}) {
  const rows = React.useMemo(() => results.map(fromResultRow), [results]);
  // Always at the run's own verdicts. `summarize` still takes a bar — the rule lives there and is
  // worth keeping in one place — but this view no longer has one to give it: the threshold moved to
  // the Network page, where it grades the pooled answer rather than one historical run.
  const facts = React.useMemo(() => summarize(rows, scoredCount), [rows, scoredCount]);

  const kind = progress?.kind ?? "facebook";
  const origin = progress?.origin ?? "import";
  // The set as one fragment, for the sentences below that name what the run was held up against.
  // Null for a whole-table run, which is a different sentence rather than a blank in this one.
  const companyLabel = formatCompanies(selectedCompanies);

  /**
   * The run scored nothing at all — which is not the same as "nothing matched", and this used to
   * conflate them by testing `results.length`.
   *
   * A run that scored 320 friends and matched none of them has zero results and 320 rows, and the
   * old test hid the table on exactly the run where the table was the only thing worth reading.
   * The honest question is whether there were any rows, which only the progress counts can answer.
   *
   * Held until `progress` actually arrives: an empty state that flashes before the first poll is
   * indistinguishable from a real one, and it says the run is empty when nobody has looked yet.
   */
  if (progress && progress.total === 0) {
    return (
      <EmptyState
        icon={Users}
        title="Nothing to compare"
        description={
          kind === "company"
            ? "This run had no company contacts to score. Import a company file first."
            : `There are no Facebook friends on file, so there was nothing to score against ${
                companyLabel ?? "the company contacts"
              }. Import a friends export first.`
        }
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/uploads">
              <UploadCloud className="h-4 w-4" /> Import data
            </Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      {/*
        No verdict on a run that is still going, and not because it would look unfinished — because
        it would be *wrong and stuck*. `results` is fetched once and only re-fetched when the run
        completes (the poll is what notices), so a Verdict rendered mid-flight reads its facts from
        an empty array and states, in the page's largest type, that nothing matched. It would then
        sit there saying it while the rows underneath filled in with matches.
        The rows are the live view; the finding arrives when the run does.
      */}
      {!live && (
        <Verdict
          facts={facts}
          companies={selectedCompanies}
          kind={kind}
          origin={origin}
          compareBy={progress?.compareBy}
          unscored={progress?.unscored ?? 0}
        />
      )}
      {/*
        The threshold slider used to sit here, between the finding and the rows. It moved to the
        Network page — a run is a historical event and re-grading one of them moved nothing anybody
        acts on; the pooled answer is what people read, and that is where the bar can change it.
        See `NetworkThreshold`.
      */}
      <RunRows comparisonId={comparisonId} progress={progress} live={live} company={companyLabel} />
    </div>
  );
}
