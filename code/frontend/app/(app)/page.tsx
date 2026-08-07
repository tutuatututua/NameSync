"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Building2, History, Search, Users } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { NetworkThreshold } from "@/components/network/NetworkThreshold";
import { OverviewTab } from "@/components/network/OverviewTab";
import { ResultsTab } from "@/components/network/ResultsTab";
import { SearchTab } from "@/components/network/SearchTab";
import { UploadersTab } from "@/components/network/UploadersTab";
import { useNetworkGrading } from "@/hooks/queries";
import { thresholdParam, useThreshold } from "@/hooks/useThreshold";

/**
 * Network — the app's home, and its everyday jobs in one place.
 *
 * The screen used to be one thing ("Compare") wearing another name ("Network"), running three
 * jobs through a single state machine — which is what made it confusing. Now the name matches the
 * work and each job has its own tab:
 *
 * Left to right — Company · Relationship owners · Results · Search, with Company the home (the URL
 * default):
 *   · Company   — the state of your network: which companies your friends reach, and how many
 *     friends you've uploaded. A company row opens the company's own page (`/companies/:name`).
 *   · Relationship owners — search an owner and see how many of their names matched vs. didn't; a
 *     row opens the roster's own page (`/uploaders/:name`) with the actual names. The tab value and
 *     the route keep the older "uploaders" spelling — they are links people have, and only the
 *     wording on screen changed.
 *   · Results   — every comparison that has been run, newest first, each one re-askable with
 *     different criteria. A row opens the run's own page (`/comparisons/:id`). See `ResultsTab`.
 *   · Search    — look a person up by name: which company they're in, and who in your network knows
 *     them. Editing a contact's name lives here, inline.
 *
 * There is no "Compare" tab: with the external matcher every import auto-matches against everything
 * on file, so a run is created by uploading, not by a manual step. Runs are STARTED from whatever
 * they are about — a company row, an owner, an import, a past run — and every one of them opens the
 * same dialog and hands off to `/comparisons/:id`, the one canonical place a run is watched. What
 * Results adds is the way back IN: a finished run is where the next question comes from.
 *
 * The tab lives in the URL (`?tab=`), so it's linkable and the back button works.
 *
 * ── The match threshold sits above the tabs, not inside one ──
 *
 * It grades the same thing on the three tabs it applies to — a stored result row — so a copy per
 * tab would be controls that had to be kept in step, and a bar set on Company that reverted on
 * Search would make the two tabs disagree about the same database. Above the rail it is visibly a
 * property of the WORKSPACE, which is what it is: it rides in this page's URL (`?threshold=`) and is
 * handed to each tab, which passes it to its query and hangs it on every link it draws out to a
 * company or roster page. See `useThreshold` and `UNGRADED_TABS`.
 */

/**
 * Left-to-right: Company · Relationship owners · Results · Search. "company" is the home tab (the
 * URL default), so it maps to a bare "/"; the rest carry a `?tab=`. The internal value "company"
 * replaced "overview" when the tab was renamed — the component behind it is still the network
 * snapshot.
 *
 * ── WHY THESE FOUR, AFTER IMPORTS CAME AND WENT ──
 *
 * For a day the first three were the three compare scopes from the contract's vocabulary
 * (`run-scope.ts`): company, owner, file — with Imports standing in for `file`. The symmetry was
 * real and it organised this page around what the SERVER does with a row rather than what somebody
 * came here to do. A table of files is a thing you consult while holding a file, which is the
 * Uploads page; it went back there (`ImportsTable`), and this page took Results in its place.
 *
 * What is left reads as one job in four questions: which companies do we reach, whose friends get
 * us there, what have we found so far, and where is this one person. Three of them are reads over
 * the same graded result table; Results is the record of the runs that filled it, and the place a
 * past run is asked again. Search is the lookup, and it stays last.
 */
type TabValue = "company" | "uploaders" | "results" | "search";
const TABS: readonly TabValue[] = ["company", "uploaders", "results", "search"];
const DEFAULT_TAB: TabValue = "company";

/**
 * Tabs the similarity bar has nothing to say about.
 *
 * The bar re-grades stored `comparison_result` rows at a threshold the reader picks. Results counts
 * each run's own verdicts through `GET /comparisons`, which takes no bar — so the control would sit
 * above it doing visibly nothing, which reads as broken rather than as inapplicable. (It is the
 * same reason Imports was listed here: neither tab reads a graded row.)
 *
 * HIDDEN, NOT DISABLED, and the value is NOT reset: it stays in the URL and comes back with the
 * reader when they return to a tab it grades. A bar that silently reverted on the way through here
 * would make switching tabs a way to lose your setting.
 */
const UNGRADED_TABS: readonly TabValue[] = ["results"];

export default function NetworkPage() {
  // `useSearchParams` opts the subtree out of prerendering; the fallback is the page's resting
  // shape, so nothing jumps.
  return (
    <React.Suspense fallback={<NetworkSkeleton />}>
      <NetworkWorkspace />
    </React.Suspense>
  );
}

function NetworkWorkspace() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  /**
   * Validated, so a stale link lands on the home tab rather than on a rail with nothing selected.
   *
   * EVERY TAB IS EVERY ACCOUNT'S NOW, and that is a consequence of Imports leaving rather than a
   * relaxation. That tab called `GET /api/upload-sessions`, which is deliberately off the reviewer
   * allowlist (`api/src/lib/roles.ts`) because it is the Uploads page's endpoint — so the page had
   * to hide it from reviewers, or hand them a panel whose every request 403s. Results calls
   * `GET /api/comparisons`, which reviewers may already read; the one control on it that WRITES is
   * absent for them from inside `CompareScopeButton`. So the boundary is where it always was, and
   * this page no longer needs a list of exceptions to it.
   */
  const activeTab: TabValue = TABS.includes(tabParam as TabValue)
    ? (tabParam as TabValue)
    : DEFAULT_TAB;
  const [threshold, setThreshold] = useThreshold();
  // What the bar can actually move. Read here, beside the control, rather than inside a tab: it
  // describes the whole result table, so it is the same answer at every roster and every bar.
  const grading = useNetworkGrading();

  function onTabChange(next: string) {
    // The bar survives a tab change — it is a property of the workspace, and dropping it here would
    // make switching tabs a silent reset. Rebuilt from the current params rather than appended, so
    // `?q=` (the deep link into Search) is not carried onto a tab that has no use for it.
    const sp = new URLSearchParams();
    if (next !== DEFAULT_TAB) sp.set("tab", next);
    // Through the same spelling every link uses: null is `off`, the default bar is left off the URL
    // entirely. Writing `String(threshold)` here would put `off` on the URL as "null".
    const param = thresholdParam(threshold);
    if (param !== null) sp.set("threshold", param);
    const q = sp.toString();
    router.replace(q ? `/?${q}` : "/");
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Network"
        description="See who your friends connect to, or look someone up by name."
      />

      {/* Above the tabs because it grades the ones it applies to — see the file header and
          `UNGRADED_TABS`, which is why this is a condition rather than an unconditional render. */}
      {!UNGRADED_TABS.includes(activeTab) && (
        <NetworkThreshold
          value={threshold}
          onChange={setThreshold}
          scored={grading.data?.scored}
          results={grading.data?.results}
        />
      )}

      <Tabs value={activeTab} onValueChange={onTabChange}>
        <TabsList>
          <TabsTrigger value="company" className="gap-1.5">
            <Building2 className="h-4 w-4" /> Company
          </TabsTrigger>
          <TabsTrigger value="uploaders" className="gap-1.5">
            <Users className="h-4 w-4" /> Relationship owners
          </TabsTrigger>
          <TabsTrigger value="results" className="gap-1.5">
            <History className="h-4 w-4" /> Results
          </TabsTrigger>
          <TabsTrigger value="search" className="gap-1.5">
            <Search className="h-4 w-4" /> Search
          </TabsTrigger>
        </TabsList>

        <TabsContent value="company">
          <OverviewTab threshold={threshold} />
        </TabsContent>
        <TabsContent value="uploaders">
          <UploadersTab threshold={threshold} />
        </TabsContent>
        {/* No `threshold`: this tab reads each run's own verdicts, not graded result rows. See
            `UNGRADED_TABS`. */}
        <TabsContent value="results">
          <ResultsTab />
        </TabsContent>
        <TabsContent value="search">
          <SearchTab threshold={threshold} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** The page's resting shape, for the Suspense boundary — header, the bar, then the tab rail. */
function NetworkSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </div>
      <Skeleton className="h-[132px] rounded-lg" />
      <Skeleton className="h-9 w-52" />
      <div className="grid gap-3 sm:grid-cols-3">
        <Skeleton className="h-[92px] rounded-lg" />
        <Skeleton className="h-[92px] rounded-lg" />
        <Skeleton className="h-[92px] rounded-lg" />
      </div>
    </div>
  );
}
