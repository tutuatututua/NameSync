"use client";

import { RecentRuns } from "@/components/network/RecentRuns";

/**
 * Results — every comparison this product has run, and the way to ask any of them again.
 *
 * ── WHAT THIS TAB REPLACED, AND WHY ──
 *
 * Imports stood here for a day. It was a table of FILES on the page where you look at FINDINGS, and
 * the two are different jobs: "have I uploaded this yet" is asked with a file in hand and belongs
 * beside the drop zones (it is back on `/uploads`), while "what did we find, and what should I ask
 * next" is what somebody opens this product for on a morning when they are not uploading anything.
 *
 * The run list was already here — folded under the company list at the bottom of the Company tab,
 * narrowed to the runs that had no page of their own. As a footer under a longer list it read as
 * bookkeeping; as a tab it is the answer. So it is promoted, unfiltered, and given the one action
 * that makes a past run worth returning to: run it again, differently. See `rerunRequest`.
 *
 * ── ONE LIST, NOT A SECOND COPY ──
 *
 * `RecentRuns` with no filter is deliberately the whole of this tab. A company's runs still list on
 * that company's page and an owner's on theirs, because that is where the button that would start
 * another one is — but those are the same rows seen from a narrower place, not a second record.
 * Nothing is stored twice, and the Company tab no longer carries a run list of its own.
 *
 * This is a thin component, and it stays one on purpose: everything that could accumulate here —
 * a scope filter, an order, a date range — is a question `GET /comparisons` should answer, not
 * something to re-implement over one page of rows in the browser. When the list outgrows a search
 * box, that is the change to make. IT IS OVERDUE: `useComparisons` fetches every run and the filter
 * box narrows the array in the browser, which was tolerable when this tab was a history and is not
 * now that every import adds a row to it.
 *
 * ── IT STARTS RUNS AS WELL AS LISTING THEM (2026-08-06) ──
 *
 * `canStartRuns` puts "New comparison" in the header. It is here because the three other places a
 * run could be started from were removed on the same day — the Network header's "Find connections",
 * the Uploads table's per-import Compare, and (by consequence) any path that did not begin at a
 * company or an owner. Without it this tab could only ever REPEAT a question somebody had already
 * asked, which is a strange thing for the one screen whose subject is runs.
 *
 * The scoped lists on `/companies/[name]` and `/uploaders/[name]` deliberately do NOT get it: they
 * already carry a scoped Compare in their own headers, and an unscoped button under a scoped list
 * would offer a broader run than the page it sits on.
 *
 * ── THE MATCH THRESHOLD IS NOT ABOVE THIS TAB ──
 *
 * See `UNGRADED_TABS` on the page. A run's "12 matches of 50 scored" comes from `GET /comparisons`,
 * which counts the matcher's own verdicts and takes no bar; the bar re-grades stored result rows on
 * the tabs that read them. Hanging it over numbers it cannot move would read as broken.
 */
export function ResultsTab() {
  // No `filter`: every run in the product, newest first — see `RecentRuns` for why this one is
  // unfiltered where the per-scope pages are not. The empty state is the default one, which is the
  // right advice here: with no runs at all, what is missing is imported data, and it carries the
  // button that goes and gets it.
  return <RecentRuns title="All comparisons" canStartRuns />;
}
