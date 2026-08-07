"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Search, ServerCrash, UserX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatTile, compactCount } from "@/components/stat-tile";
import { MatchedHint, rosterMatchTitle } from "@/components/network/match-grade";
import { CompareScopeButton } from "@/components/network/CompareScopeButton";
import { RecentRuns } from "@/components/network/RecentRuns";
import { ThresholdNote } from "@/components/network/ThresholdNote";
import { MatchedSection } from "@/components/network/uploader/MatchedSection";
import {
  EveryoneConnected,
  NoMatchSection,
} from "@/components/network/uploader/NoMatchSection";
import {
  countFriends,
  filterGroups,
  hitsNoMatch,
  SEARCH_AT,
} from "@/components/network/uploader/roster";
import { useNetworkUploader } from "@/hooks/queries";
import { readThreshold, withThreshold } from "@/hooks/useThreshold";

/**
 * One relationship owner — every friend they contributed, split into the names their network placed
 * and the names it hasn't.
 *
 * This is the drill-down behind the Relationship owners tab and behind every "known by / reached
 * by" chip in the app: the counts were always visible, but the *names* were not, and the names are
 * the point — "which of my friends still has no connection" is the list you act on. Matched friends
 * carry the person they reach and the company they reach them at (a link straight to it); unmatched
 * friends carry whatever a run recorded while turning them down, and are split by whether one ever
 * did — see `NoMatchSection`.
 *
 * ── WHAT IS IN THIS FILE, AND WHAT IS NOT (2026-08-06) ──
 *
 * This is the page's SHELL: which state the page is in (loading, failed, empty, populated), the
 * counts across the whole roster, and the one search box that covers both halves. The two halves
 * render themselves — `MatchedSection` and `NoMatchSection` — and everything either of them counts
 * or narrows lives in `roster.ts`.
 *
 * The split is not tidiness. The arithmetic and the markup used to sit in one function, and they
 * drifted into disagreement exactly where you would expect: a company header counting result rows
 * over a list that folded them. What the page states and what the page draws now come from the same
 * few functions, and those functions are the only thing that has to be right.
 *
 * ── One search box, over BOTH halves ──
 *
 * The filter used to sit inside "No match" and reach only that list, which made the obvious
 * question — "did we place khun somchai or not?" — the one thing it could not answer: typing the
 * name filtered the unplaced list and left the placed one untouched above it, so a hit and a miss
 * looked identical until you read the whole page.
 *
 * It is now one box above both sections, and it filters CLIENT-side, unlike every other search in
 * the app. That is not an inconsistency but the shape of the data: this page fetches one roster
 * whole (the endpoint is scoped to a single owner and returns both lists complete, precisely
 * because a roster is small), so there is no second page for a server search to reach. The rule
 * this codebase actually holds is "never filter a page and call it the list" — here the page IS
 * the list.
 */
export default function UploaderPage() {
  const params = useParams<{ name: string }>();
  // Next decodes the route param, so this is the owner's real (case-preserving) name.
  const name = decodeURIComponent(String(params.name));
  /**
   * The bar the Network page was tuned to, carried here on the link that opened this page.
   *
   * READ, never set — there is no control on this page; see the company page for why a second
   * authority for one setting is worse than none. It moves BOTH lists below at once: a friend the
   * raised bar drops out of "matched" appears under "no match" carrying the near miss that is now
   * the score which failed to clear it.
   */
  const threshold = readThreshold(useSearchParams().get("threshold"));
  const { data, isLoading, isError, refetch } = useNetworkUploader(name, threshold ?? undefined);

  // Memoized on the payload, not read inline: both feed the filters below, and `?? []` produces a
  // fresh empty array every render — which would re-run the whole filter on every keystroke
  // anywhere on the page.
  const matched = React.useMemo(() => data?.matchedByCompany ?? [], [data]);
  const noMatch = React.useMemo(() => data?.noMatchPeople ?? [], [data]);
  const importedBy = data?.importedBy ?? [];

  const [query, setQuery] = React.useState("");
  const needle = query.trim().toLowerCase();
  const matchedShown = React.useMemo(() => filterGroups(matched, needle), [matched, needle]);
  const noMatchShown = React.useMemo(
    () => (needle ? noMatch.filter((p) => hitsNoMatch(p, needle)) : noMatch),
    [noMatch, needle]
  );
  // On the ROSTER's size, not on either list's — the box has to survive a search that empties one
  // half, or the only way out of a typo is the back button.
  const showSearch = !isLoading && !isError && (data?.friends ?? 0) >= SEARCH_AT;

  /**
   * Matched friends the list below has nowhere to put — their run recorded no company.
   *
   * The server has always allowed this (`matched` counts a connection whether or not it named a
   * company) and the page never said so, which left the Matched tile and the sections under it
   * differing by a number with no explanation on screen. Computed from the UNFILTERED groups: it is
   * a fact about the roster, not about the search.
   */
  const ungrouped = Math.max(0, (data?.matched ?? 0) - countFriends(matched));

  return (
    <div className="space-y-8">
      <PageHeader
        backHref={withThreshold("/?tab=uploaders", threshold)}
        backLabel="Relationship owners"
        title={name}
        description={
          <>
            The friends this person owns the relationship with, and how many their network reaches.
            {/* Who typed the roster in — a different person from the one this page is about
                whenever an assistant imported on someone's behalf, which is the whole reason an
                owner is stored per friend row rather than per upload. Rendered only when there is
                an import on file to name, and only as a second line: it is provenance, not the
                subject of the page. */}
            {importedBy.length > 0 && (
              <span className="mt-1 block text-sm">Imported by {importedBy.join(", ")}</span>
            )}
          </>
        }
        /*
          Compare THIS roster again — the action the "No match" list below exists to prompt.

          That list is the page's finding and, until now, its dead end: the names on it have no
          connection under the runs made so far, and the obvious next question ("would they match on
          Thai names? on surnames?") could not be asked of just these people. It can now, and this is
          where it belongs — beside the roster it is about, not on a workspace tab where the owner
          would have to be re-selected from a picker.
        */
        actions={<CompareScopeButton scope={{ filterBy: "owner", filterValue: name }} />}
      />

      {/* WHAT THIS ROSTER IS BEING READ AT. The bar arrives on the link that opened this page and
          moves both lists below; until it was stated, arriving at a tuned workspace's roster and
          arriving at an untuned one looked exactly alike. See `ThresholdNote`. */}
      <ThresholdNote threshold={threshold} changeHref="/?tab=uploaders" className="-mt-4" />

      {isLoading ? (
        <UploaderSkeleton />
      ) : isError ? (
        /*
          A FAILED REQUEST IS NOT AN EMPTY ROSTER.

          Without this branch the page fell through to the populated case with `data` undefined,
          which rendered every tile as 0 and both lists as their empty states — so a dropped
          connection told the reader "No matches yet" and "Everyone's connected" in the same breath.
          Two confident, opposite, false claims about somebody's data. The state deserves its own
          branch and a way out of it.
        */
        <EmptyState
          icon={ServerCrash}
          title="Couldn't load this roster"
          description="The request for this person's friends didn't come back. Nothing has changed — this page only reads."
          action={
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          }
        />
      ) : data && data.friends === 0 ? (
        <EmptyState
          icon={UserX}
          title="No friends on file for this relationship owner"
          /* The third reason is new, and it is the one that actually fired: this page is keyed on
             whose relationship a friend is, and a name that only ever performed IMPORTS owns
             nothing. Worth naming rather than leaving the reader to conclude their data is gone —
             "removed or misspelled" is alarming, and both were wrong. */
          description="Their roster may have been removed, the name may be spelled differently, or this person imported friends for somebody else and owns no relationships of their own."
          action={
            <Link
              href={withThreshold("/?tab=uploaders", threshold)}
              className="text-sm font-medium text-primary hover:underline"
            >
              Back to relationship owners
            </Link>
          }
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile
              label="Friends"
              value={compactCount(data?.friends ?? 0)}
              hint="on this owner's list"
            />
            {/* The two graded tiles are the sections below them, so they say so and go there. The
                rule this app holds everywhere is that the thing you press and the number on it
                answer the same question — these were the two numbers on the page where that was
                true and unexploited. */}
            <TileLink
              href="#matched"
              label="Jump to the matched friends"
              /* The same sentence the roster's badge on the Relationship owners tab carries, so
                 the tile and the row that linked here explain the split identically. */
              tooltip={
                (data?.matched ?? 0) === 0
                  ? "Friends with a connection"
                  : rosterMatchTitle(data?.matched ?? 0, data?.confirmed ?? 0)
              }
            >
              <StatTile
                label="Matched"
                value={compactCount(data?.matched ?? 0)}
                hint={
                  <MatchedHint
                    matched={data?.matched ?? 0}
                    confirmed={data?.confirmed ?? 0}
                    fallback="friends with a connection"
                  />
                }
                emphasis
                className="h-full"
              />
            </TileLink>
            <TileLink
              href="#no-match"
              label="Jump to the friends with no connection"
              tooltip="Friends this owner uploaded that no run has placed with anybody yet."
            >
              <StatTile
                label="No match"
                value={compactCount(data?.noMatch ?? 0)}
                hint="friends with none"
                className="h-full"
              />
            </TileLink>
          </div>

          {/* ONE box for the whole roster — see the file header. It sits above both sections
              rather than inside either, because which section a name turns up in is the answer it
              exists to give. */}
          {showSearch && (
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative w-full sm:max-w-md">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  // Escape clears it, which is what every reader tries first and what the two empty
                  // states below offer a button for — the same way out, from the keyboard.
                  onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                  placeholder="Search this roster — a friend, a company, a near miss…"
                  className="pl-9 pr-9"
                  aria-label={`Search ${name}'s friends`}
                />
                {query && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setQuery("")}
                    aria-label="Clear search"
                    className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
              {needle && (
                <p
                  aria-live="polite"
                  className="text-sm tabular-nums text-muted-foreground"
                >
                  {countFriends(matchedShown).toLocaleString()} matched ·{" "}
                  {noMatchShown.length.toLocaleString()} unmatched
                </p>
              )}
            </div>
          )}

          <MatchedSection
            groups={matched}
            shown={matchedShown}
            query={query}
            threshold={threshold}
            ungrouped={ungrouped}
            onClearSearch={() => setQuery("")}
          />

          {noMatch.length === 0 ? (
            <EveryoneConnected />
          ) : (
            <NoMatchSection
              people={noMatch}
              shown={noMatchShown}
              query={query}
              onClearSearch={() => setQuery("")}
            />
          )}
        </>
      )}

      {/*
        WHAT HAS ALREADY BEEN ASKED ABOUT THIS ROSTER — the owner-side twin of the list on a
        company page, and here for the same reason: the Compare button in this page's header is
        what would start another one, so the runs that already exist belong beside it rather than
        on a workspace list covering everybody. See `RecentRuns`.
      */}
      <RecentRuns
        filter={{ axes: ["owner"], value: name }}
        title="Comparisons of this roster"
        emptyDescription={`No comparison has covered ${name}'s friends yet. Use Compare above to score them against the contacts on file.`}
      />
    </div>
  );
}

/**
 * A tile that goes where its number does.
 *
 * An anchor and not a router push: the destination is on this page, so the browser's own
 * `scroll-mt` handling is both correct and free, and the link is a real one — middle-clickable,
 * copyable, and readable by a screen reader as a jump rather than as a button that does something
 * unexplained.
 */
function TileLink({
  href,
  label,
  tooltip,
  children,
}: {
  href: string;
  label: string;
  /** What the tile's hint is shorthand for, in a sentence. */
  tooltip?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      aria-label={label}
      title={tooltip}
      className="rounded-lg outline-none transition-shadow hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {children}
    </a>
  );
}

function UploaderSkeleton() {
  return (
    <div className="space-y-8">
      <div className="grid gap-3 sm:grid-cols-3">
        <Skeleton className="h-[92px] rounded-lg" />
        <Skeleton className="h-[92px] rounded-lg" />
        <Skeleton className="h-[92px] rounded-lg" />
      </div>
      <Skeleton className="h-44 rounded-lg" />
      <Skeleton className="h-28 rounded-lg" />
    </div>
  );
}
