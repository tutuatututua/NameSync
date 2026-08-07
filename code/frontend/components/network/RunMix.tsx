"use client";

import * as React from "react";
import {
  COMPARE_LANGUAGES,
  COMPARE_TYPES,
  LANGUAGE_LABEL,
  TYPE_LABEL,
  compareByAxes,
} from "@extensions/contract";
import { Card, CardContent } from "@/components/ui/card";
import { SectionHeader } from "@/components/page-header";
import { RunMixDonut, type DonutSegment } from "@/components/network/RunMixDonut";
import { useComparisons } from "@/hooks/queries";

/**
 * How much COMPARED DATA sits behind each way of comparing — the stored result rows, split by the
 * language and the name part of the run that produced them.
 *
 * ── ROWS, NOT RUNS ──
 *
 * It counted runs until 2026-08-04, and the two answer different questions. "6 of 9 runs were
 * English" describes what people chose; "30 of 45 stored rows came from English runs" describes
 * what the database is actually made of, which is the one that scales with the data rather than
 * with how often somebody pressed a button. A single run over 4,000 friends and a run over 3 count
 * the same under the old reading and 1,300× apart under this one.
 *
 * ── WHAT A "ROW" IS, AND WHY THE TOTAL EXCEEDS THE FRIEND COUNT ──
 *
 * One stored `comparison_result` — one name a run compared and recorded. **The same friend
 * contributes a row to every run that scored them**, so these totals are rows of evidence, not
 * people: nine runs over five friends is forty-five rows, not five. That is the honest unit for
 * "how much of our matching is Thai" and the wrong one for "how many friends do we have", which is
 * what the Friends tile above already answers. The labels say "rows" everywhere for exactly that
 * reason — never "friends", never "names".
 *
 * ── NO NEW REQUEST ──
 *
 * Both rings are folded out of `useComparisons()`, which the run list further down already loads:
 * same query key, so React Query serves one fetch for both. `rowCount` rides on each run in that
 * payload, aggregated server-side from `comparison_result` (`ComparisonModel.listWithStats`), so
 * the ratio and the per-run counts in "Recent comparisons" are the same numbers and cannot drift.
 *
 * `compareBy` arrives already resolved (`ComparisonListItemSchema` types it as `CompareBy`, never
 * null), so the axes come straight from the contract's own `compareByAxes` — the same splitter the
 * server folds its copy with. No second parsing rule.
 *
 * ── NOT SCOPED BY THE ROSTER PICKER OR THE THRESHOLD ──
 *
 * A run is not owned by a relationship owner — it scores whichever friends its `sources` axis
 * covers, across every roster — and `GET /comparisons` takes no `threshold`, so neither control
 * above moves these rings. That is why they sit OUTSIDE the block those controls dim: fading a
 * chart that is not being recomputed states it is stale when it is not.
 */
export function RunMix() {
  const { data, isLoading } = useComparisons();
  const runs = React.useMemo(() => data ?? [], [data]);

  /**
   * One pass, both axes — and driven by the vocabulary rather than by what turned up.
   *
   * A language nothing has been compared in is a `0%` segment that still holds its slot in the
   * legend, which is the answer to "are we doing any Thai matching at all". Counting only the
   * values present would let the legend gain and lose rows as runs land, and would silently
   * reassign colours with them.
   *
   * `total` is summed here rather than taken from `runs.length` for the obvious reason and one
   * less obvious one: a run that produced no rows (it failed, or its rows were rolled back) must
   * contribute nothing to a chart about stored data, and summing the same numbers the segments are
   * built from is what keeps the ring's parts adding to the number in its hole.
   */
  const { byLanguage, byType, total } = React.useMemo(() => {
    const language = new Map(COMPARE_LANGUAGES.map((l) => [l, 0]));
    const type = new Map(COMPARE_TYPES.map((t) => [t, 0]));
    let rows = 0;

    for (const run of runs) {
      const axes = compareByAxes(run.compareBy);
      language.set(axes.language, (language.get(axes.language) ?? 0) + run.rowCount);
      type.set(axes.type, (type.get(axes.type) ?? 0) + run.rowCount);
      rows += run.rowCount;
    }

    return {
      total: rows,
      byLanguage: COMPARE_LANGUAGES.map<DonutSegment>((l) => ({
        key: l,
        label: LANGUAGE_LABEL[l],
        value: language.get(l) ?? 0,
      })),
      byType: COMPARE_TYPES.map<DonutSegment>((t) => ({
        key: t,
        label: TYPE_LABEL[t],
        value: type.get(t) ?? 0,
      })),
    };
  }, [runs]);

  // "rows", never "friends" — see the header. The unit is the whole reason the total can exceed
  // the Friends tile a few inches above it without either number being wrong.
  const rowLabel = total === 1 ? "row" : "rows";

  return (
    <section className="space-y-4">
      <SectionHeader
        title="How your data was compared"
        description="Every compared row on file, by the language and the name part of the run behind it. A friend counts once per run that scored them, so this totals rows of evidence rather than people — and it ignores the owner filter and the bar above, which do not move it."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardContent className="p-5">
            <RunMixDonut
              title="Language"
              segments={byLanguage}
              total={total}
              totalLabel={rowLabel}
              isLoading={isLoading}
              emptyLabel="Nothing compared yet — the split appears once a run has stored some rows."
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <RunMixDonut
              title="Name part"
              segments={byType}
              total={total}
              totalLabel={rowLabel}
              isLoading={isLoading}
              emptyLabel="Nothing compared yet — the split appears once a run has stored some rows."
            />
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
