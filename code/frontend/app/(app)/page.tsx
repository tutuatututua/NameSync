"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Building2, Search, Users } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { OverviewTab } from "@/components/network/OverviewTab";
import { SearchTab } from "@/components/network/SearchTab";
import { UploadersTab } from "@/components/network/UploadersTab";

/**
 * Network — the app's home, and its two everyday jobs in one place.
 *
 * The screen used to be one thing ("Compare") wearing another name ("Network"), running three
 * jobs through a single state machine — which is what made it confusing. Now the name matches the
 * work and each job has its own tab:
 *
 * Left to right — Company · Relationship owners · Search, with Company the home (the URL default):
 *   · Company   — the state of your network: which companies your friends reach, how many friends
 *     you've uploaded, and the history of every comparison run. A company row opens the company's
 *     own page (`/companies/:name`).
 *   · Relationship owners — search an owner and see how many of their names matched vs. didn't; a
 *     row opens the roster's own page (`/uploaders/:name`) with the actual names. The tab value and
 *     the route keep the older "uploaders" spelling — they are links people have, and only the
 *     wording on screen changed.
 *   · Search    — look a person up by name: which company they're in, and who in your network knows
 *     them. Editing a contact's name lives here, inline.
 *
 * There is no "Compare" tab: with the external matcher every import auto-matches against everything
 * on file, so a run is created by uploading, not by a manual step. The occasional ad-hoc run is a
 * button on Overview that hands off to the run's own page (`/comparisons/:id`) — the one canonical
 * place a run is watched — so a run has a single home, not three.
 *
 * The tab lives in the URL (`?tab=`), so it's linkable and the back button works.
 */

// Left-to-right: Company · Relationship owners · Search. "company" is the home tab (the URL default), so it
// maps to a bare "/"; the other two carry a `?tab=`. The internal value "company" replaced
// "overview" when the tab was renamed — the component behind it is still the network snapshot.
type TabValue = "company" | "uploaders" | "search";
const TABS: readonly TabValue[] = ["company", "uploaders", "search"];
const DEFAULT_TAB: TabValue = "company";

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
  const activeTab: TabValue = TABS.includes(tabParam as TabValue) ? (tabParam as TabValue) : DEFAULT_TAB;

  function onTabChange(next: string) {
    // Company is the default, so it needs no param.
    router.replace(next === DEFAULT_TAB ? "/" : `/?tab=${next}`);
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Network"
        description="See who your friends connect to, or look someone up by name."
      />

      <Tabs value={activeTab} onValueChange={onTabChange}>
        <TabsList>
          <TabsTrigger value="company" className="gap-1.5">
            <Building2 className="h-4 w-4" /> Company
          </TabsTrigger>
          <TabsTrigger value="uploaders" className="gap-1.5">
            <Users className="h-4 w-4" /> Relationship owners
          </TabsTrigger>
          <TabsTrigger value="search" className="gap-1.5">
            <Search className="h-4 w-4" /> Search
          </TabsTrigger>
        </TabsList>

        <TabsContent value="company">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="uploaders">
          <UploadersTab />
        </TabsContent>
        <TabsContent value="search">
          <SearchTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** The page's resting shape, for the Suspense boundary — header + the tab rail. */
function NetworkSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </div>
      <Skeleton className="h-9 w-52" />
      <div className="grid gap-3 sm:grid-cols-3">
        <Skeleton className="h-[92px] rounded-lg" />
        <Skeleton className="h-[92px] rounded-lg" />
        <Skeleton className="h-[92px] rounded-lg" />
      </div>
    </div>
  );
}
