"use client";

import * as React from "react";
import Link from "next/link";
import { UploadCloud, Users } from "lucide-react";
import type { ComparisonResultRow } from "@extensions/contract";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { Verdict } from "@/components/results/Verdict";
import { MergeSummary } from "@/components/results/MergeSummary";
import { MatchTable } from "@/components/results/MatchTable";
import { fromResultRow, summarize } from "@/lib/match";

/**
 * A finished run: what it found, what went into it, and the rows behind it — in that order.
 *
 * The order is the argument, and it used to run the other way. The page opened on four stat
 * tiles (Friends scored / Mean similarity / Lowest / Highest), and only "Friends scored" was
 * about anything the reader wanted: the other three are statistics over a population that is
 * mostly strangers, so they described the noise rather than the finding, and two runs with
 * wildly different results read almost the same through them.
 *
 * Now: `Verdict` says what the run found. `MergeSummary` says where the two halves of a row
 * came from — a reader who doesn't know a row is two records fused by a score will misread
 * every row under it. `MatchTable` is the evidence, and it opens on the matches.
 */
export function ResultsView({
  results,
  scoredCount,
  selectedCompany,
}: {
  results: ComparisonResultRow[];
  /** How many names the run looked at. See ResultsData.scoredCount — with the external
   *  matcher this is larger than `results.length`, because a workflow only writes back the
   *  rows that matched. */
  scoredCount?: number;
  selectedCompany?: string | null;
}) {
  const rows = React.useMemo(() => results.map(fromResultRow), [results]);
  const facts = React.useMemo(() => summarize(rows, scoredCount), [rows, scoredCount]);

  const company = selectedCompany ?? null;

  // Reachable: import company data, import no friends, compare. The verdict and the merge
  // picture would otherwise each render a well-formatted zero.
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="Nothing to compare"
        description={`There are no Facebook friends on file, so there was nothing to score against ${
          company ?? "the company"
        }. Import a friends export first.`}
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
      <Verdict facts={facts} company={company} />
      <MergeSummary facts={facts} company={company} />
      <MatchTable rows={rows} company={company} scoredCount={facts.friends} />
    </div>
  );
}
