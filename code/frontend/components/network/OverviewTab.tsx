"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  Building2,
  GitCompareArrows,
  Link2,
  Loader2,
  Search,
  SearchX,
  UserSearch,
  X,
} from "lucide-react";
import type { CompanyConnection, CompanySort, RequestedScope } from "@extensions/contract";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { StatTile, compactCount } from "@/components/stat-tile";
import { EmptyState } from "@/components/empty-state";
import { SectionHeader } from "@/components/page-header";
import { PAGE_SIZE as SHARED_PAGE_SIZE, Pager } from "@/components/pagination";
import { RunMix } from "@/components/network/RunMix";
import {
  NewComparisonDialog,
  type ComparisonSeed,
} from "@/components/network/NewComparisonDialog";
import {
  MatchedHint,
  ReachLeads,
  companyReachTitle,
  reachBadgeVariant,
} from "@/components/network/match-grade";
import { usePermissions } from "@/components/auth-provider";
import { useNetworkOverview, useOwnerOptions } from "@/hooks/queries";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { withThreshold } from "@/hooks/useThreshold";
import { cn } from "@/lib/utils";

/**
 * How many companies one screen of the list holds.
 *
 * The list was every company the roster reaches, unbounded, which is a list nobody reads past the
 * first screen of and a payload that grew with the database on the one request the threshold bar
 * re-issues on every drag. Twenty is a screen; the rest is reached by searching or by paging, which
 * is what the two controls above the list are for. That paging carries more weight now that the
 * list holds every company on file rather than only the reached ones.
 *
 * Twenty is the app's page, not this list's — see `components/pagination`, which owns both the size
 * and the control that turns it.
 */
const PAGE_SIZE = SHARED_PAGE_SIZE;

/**
 * Below this many companies, the list's own controls (the count line and the sort) are not offered.
 *
 * The same judgement `RunRows` makes about its filter tabs: a control for a list you can take in
 * whole is chrome the reader has to rule out. Measured on how many companies are ON FILE — the
 * list's own length, never the number currently on screen — so a search narrowed to two rows does
 * not remove the line that says it matched 2 of 412.
 *
 * NOT what gates the query bar above the tiles. That one is the tab's only way to reach the owner
 * filter, and an owner filter is a question about the friend roster rather than about the company
 * list — so a small company list must not be able to hide it. See `showQuery`.
 */
const CONTROLS_MIN = 10;

/**
 * Overview (Feature 1) — the home tab: a roster's reach across every company. (It carried the run
 * history too until Results became a tab of its own; see the note where that list used to render.)
 *
 * Answers the client's "how many companies did the user match / not match" and "how many friends
 * did they upload": narrow to whose friends you mean, and read the tiles. It reads stored results —
 * with the external matcher every import auto-matches, so this fills in on its own.
 *
 * ── ONE QUERY BAR, WHERE TWO CONTROLS USED TO BE (2026-08-06) ──
 *
 * The header carried a "Whose friends" combobox and a "Find connections" button, side by side.
 * Both are gone. What replaced them is a single box under the heading — see `NetworkQuery` for how
 * it splits one string across two jobs.
 *
 * The pairing was the problem. Two controls in one row read as one sentence, and the sentence was
 * wrong in both directions: a picker that looks like it belongs to the button beside it, and a
 * button that had to be taught (in 2026-08-06) to actually honour the picker, because until then it
 * silently ran every friend on file. The failure mode was never "is this a filter?" — it was "it
 * looked like it had taken my filter, and it had not". A read control and a write control cannot be
 * made to sit together safely by relabelling either one; the fix is that they no longer do.
 *
 * ── WHERE RUNS ARE STARTED FROM NOW ──
 *
 * From the thing they are about: a company row's hover action here, a company's own page, an
 * owner's page, or a past run on Results. Each opens the same `NewComparisonDialog` with the axis
 * it can answer already answered.
 *
 * A run that is about NOTHING in particular is started from Network → Results, which grew a "New
 * comparison" button on 2026-08-06 for exactly this — see `ResultsTab`. That is the replacement for
 * the button removed here, and the move is the point: it now sits on the screen whose subject is
 * runs, where the reader can see what has already been asked before asking again, rather than over
 * a tab of tallies where it read as a third filter beside the roster picker.
 *
 * `threshold` is the workspace bar from the page above (null = the matchers' own verdicts). Every
 * number here moves with it EXCEPT `friends`, which counts friend rows — that asymmetry is the
 * point of the tile row: as the bar tightens, Matched falls and No match rises by the same amount,
 * out of a roster that visibly did not change size.
 *
 * ── The company list is a PAGE; the tiles are not (2026-08-04) ──
 *
 * The reached-companies list used to be every company the roster touches, in one payload, on the
 * one request the threshold bar re-issues on every drag. It is now twenty at a time, with a search
 * and an order beside it — all three server-side, because a list that is one page of a larger
 * answer cannot be searched or sorted in the browser without the result being a statement about
 * page one dressed up as a statement about the network.
 *
 * The tiles are deliberately untouched by the company half of that. "Companies known" reads
 * `companiesKnown`, a count over the whole roster, precisely so it does not fall to 1 while
 * somebody types a company name into the query bar.
 *
 * That asymmetry is why the bar sits ABOVE the tiles rather than over the list, which is where its
 * predecessor (a plain company search) sat. The box now holds two things at once, and only one of
 * them is about the list: picking an owner re-grades every number on the tab, and a control that
 * moves the numbers has to be somewhere the reader can see them move. The tile hints say which is
 * which — Friends reads "on this owner's list" the moment one is picked.
 *
 * ── The list is EVERY COMPANY ON FILE (2026-08-06) ──
 *
 * It was the reached ones. A company with contacts on file but no connection appeared nowhere —
 * it existed only inside the "of 412 on file" hint on the tile — so the reader could see THAT they
 * were not reaching most of the database and never WHICH parts of it, which is the half of the
 * answer they can act on. Those companies are rows now, reading "no connections", and pressing one
 * opens the company page where the contacts are listed and a comparison can be run against them.
 *
 * "Companies known" did not follow it and must not: it is the numerator (reach), the list is the
 * denominator (what exists). A fresh database now reads "Companies known 0 of 412" over 412 rows
 * that each say so.
 */
export function OverviewTab({ threshold = null }: { threshold?: number | null }) {
  const [uploader, setUploader] = React.useState<string | null>(null);
  const [compareOpen, setCompareOpen] = React.useState(false);
  /**
   * WHAT the dialog was opened FOR — the scope, and anything to pre-fill under it.
   *
   * One dialog, several ways in, and the state that tells them apart lives here rather than inside
   * the list because the dialog is mounted here. Cleared when the dialog closes, so the next press
   * of the header button does not inherit the last row's question — the same reason the dialog
   * resets its own controls on close.
   */
  const [compareRequest, setCompareRequest] = React.useState<
    { scope?: RequestedScope; initial?: ComparisonSeed } | undefined
  >(undefined);
  const { canWrite } = usePermissions();

  const openCompare = React.useCallback(
    (request?: { scope?: RequestedScope; initial?: ComparisonSeed }) => {
      setCompareRequest(request);
      setCompareOpen(true);
    },
    []
  );

  /**
   * A COMPANY ROW'S RUN — a `company` scope, whatever the page is filtered to.
   *
   * It inverted for a day (2026-08-06): with a roster selected it opened an `owner` scope carrying
   * the company as a seeded selection, so "Compare" on ACME while looking at Mint's numbers asked
   * about Mint's friends at ACME rather than everybody's. Both halves survived only because the
   * dialog rendered a company picker under an owner scope, and it no longer does — the picker is
   * the unscoped run's alone (see `picksCompanies` in `NewComparisonDialog`).
   *
   * WITHOUT THAT PICKER THE INVERSION SILENTLY DROPS THE COMPANY. Pressing a company row and
   * getting a run against every company on file is the worst of the three possible answers, so the
   * axis the reader pressed is the one that goes across. The roster filter is not carried, and is
   * not lost either: the owner's own Compare button, one column over, still asks that question.
   */
  const compareCompany = React.useCallback(
    (company: string) => openCompare({ scope: { filterBy: "company", filterValue: company } }),
    [openCompare]
  );

  /**
   * The query bar's text, and the list's order and page.
   *
   * The text lives here rather than in `ConnectedCompanies` below because it is a REQUEST
   * parameter twice over: the list is one page of a server-side answer, so a search held inside the
   * list component would filter the twenty rows it happens to be holding and call that the network
   * — and the same string is what the owner lookup searches on. Debounced ONCE, here, so both reads
   * fire on the same pause and neither one is a request per keystroke.
   */
  const [companyQuery, setCompanyQuery] = React.useState("");
  const company = useDebouncedValue(companyQuery.trim(), 300);
  const [sort, setSort] = React.useState<CompanySort>("connections");
  const [page, setPage] = React.useState(1);
  // Every one of these makes "page 3" a different list, and landing on a page that no longer
  // exists reads as "there are none". The bar and the roster are in here for the same reason as
  // the search: they re-select which companies the roster reaches at all.
  React.useEffect(() => setPage(1), [company, sort, uploader, threshold]);

  const { data, isLoading, isFetching } = useNetworkOverview(uploader, threshold ?? undefined, {
    company,
    sort,
    page,
    limit: PAGE_SIZE,
  });

  /**
   * The owners matching what has been typed — the suggestions the query bar offers as a filter.
   *
   * Off the SAME debounced string the company list searches on, which is the whole idea behind one
   * box: "mint" asks both "is there a company called that" and "is there an owner called that", and
   * the two answers land together. It is its own request rather than a field on the overview payload
   * because the two move at different speeds — owners change when friends are imported, the tallies
   * change on every drag of the threshold bar, and pairing them re-sent the slower list at the
   * faster one's cadence.
   *
   * Disabled on an empty box. An empty query bar means "show me the whole company list", which is
   * not a request for every owner on file — and with no text there is nothing to suggest.
   */
  const owners = useOwnerOptions(company, company.length > 0);

  // The ROSTER's count, not the page's — `connected.length` was this number until the list became
  // one screen of a larger answer, and reading it now would report "Companies known 20" to anybody
  // who reaches more than twenty, and "1" to anybody mid-search.
  const connectedCount = data?.companiesKnown ?? 0;
  const friends = data?.friends ?? 0;
  const friendsMatched = data?.friendsMatched ?? 0;
  const friendsConfirmed = data?.friendsConfirmed ?? 0;
  // Unchanged by the grading, deliberately: leads stay inside `friendsMatched`, so this is still
  // "the roster minus everyone with a connection". Narrowing Matched to confirmed-only would have
  // pushed leads in here and restated a match as a non-match.
  const friendsNoMatch = Math.max(0, friends - friendsMatched);

  /**
   * Is the query bar worth its space? Almost always, and DELIBERATELY not on `CONTROLS_MIN`.
   *
   * The box it replaces was a secondary control — a company search sitting over a company list, so
   * below ten rows it was offering to find what you could already see, and hiding it cost nothing.
   * This one is the tab's ONLY query surface: the owner filter has no other route in since the
   * combobox was removed, and an owner filter is a question about 100 friends, not about the 7
   * companies that happen to be on file. Gating the two together would mean a database with nine
   * companies and nine rosters could not be narrowed to a roster at all.
   *
   * So: anything to search, or anything to narrow to. `owners > 1` rather than `> 0` because with a
   * single owner "Everyone" and "that owner" are the same set, and a filter that cannot change the
   * answer is not one. `CONTROLS_MIN` still governs the sort toggle down in the list, where the
   * original reasoning does hold.
   *
   * An active search or an active owner filter forces it regardless: a filter the reader cannot see
   * is a filter they cannot remove.
   *
   * Held back until the first payload lands, so it does not appear over a skeleton and then vanish.
   */
  const showQuery =
    !isLoading &&
    (companyQuery.trim().length > 0 ||
      uploader !== null ||
      (data ? data.companiesOnFile > 0 || data.owners > 1 : false));

  // Truly nothing here: no friends uploaded and no company data. Point at Uploads. (A roster with
  // friends but no connections is NOT this — it's a real answer, "you know nobody yet".)
  //
  // Reads `owners`, the COUNT, where it used to read `uploaders.length` off the array the payload
  // no longer carries. Same question, and now answered without shipping the names to ask it.
  const nothingYet =
    !isLoading && data && data.owners === 0 && data.friends === 0 && data.companiesOnFile === 0;

  return (
    <div className="space-y-8">
      <div className="space-y-6">
        {/* No `actions`. The two controls that stood here — the roster combobox and "Find
            connections" — are the ones `NetworkQuery` below replaces; see this component's header. */}
        <SectionHeader
          title="Your network"
          description="Companies your friends reach, and how many friends you've uploaded."
        />

        {nothingYet ? (
          <EmptyState
            icon={Link2}
            title="Nothing here yet"
            description={
              canWrite
                ? "Upload a friend list and some company data to see who your network can reach."
                : "Nothing has been imported yet. Someone with import access needs to add a friend list and some company data."
            }
            // No "Import data" button for a reviewer — /uploads is a page the guard would
            // bounce them straight off, so the empty state explains instead of dead-ending.
            action={
              canWrite ? (
                <Button asChild variant="outline" size="sm">
                  <Link href="/uploads">Import data</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          /*
            Dimmed, not blanked, while a new bar is in flight: `keepPreviousData` holds the last
            answer on screen so the drag has something to move, and the fade is what stops the
            previous bar's numbers from reading as this bar's. Skipped on the first load, which
            has its own skeletons.

            The fade is applied to the two GRADED blocks individually rather than to a wrapper
            around everything, because `RunMix` now sits between them and is not graded: it reads
            `GET /comparisons`, which takes neither the bar nor the roster. A wrapper would fade it
            along with its neighbours on every drag, which says "recomputing" about a chart that is
            not — and CSS opacity cannot be undone by a child, so nesting it and opting out is not
            available.
          */
          <div className="space-y-6">
            {/* Above the tiles because it moves them — see the placement note in this component's
                header. Outside the dimmed wrapper below for the same reason `RunMix` is: an input
                that fades under the cursor reads as a control that has been disabled, and this one
                is being typed into while the request it caused is still in flight. */}
            {showQuery && (
              <NetworkQuery
                value={companyQuery}
                onValueChange={setCompanyQuery}
                owner={uploader}
                onOwnerChange={setUploader}
                ownerMatches={owners.data?.owners ?? []}
                ownerMatchTotal={owners.data?.total ?? 0}
                ownersLoading={owners.isFetching}
              />
            )}

            <div
              className={cn(
                "grid gap-3 transition-opacity sm:grid-cols-2 lg:grid-cols-4",
                isFetching && !isLoading && "opacity-60"
              )}
            >
              <StatTile
                label="Friends"
                value={isLoading ? "" : compactCount(friends)}
                hint={uploader ? "on this owner's list" : "uploaded, all owners"}
                isLoading={isLoading}
              />
              {/* The number does not move — only what it is made of becomes visible. */}
              <StatTile
                label="Matched"
                value={isLoading ? "" : compactCount(friendsMatched)}
                hint={
                  <MatchedHint
                    matched={friendsMatched}
                    confirmed={friendsConfirmed}
                    fallback="friends with a connection"
                  />
                }
                emphasis
                isLoading={isLoading}
              />
              <StatTile
                label="No match"
                value={isLoading ? "" : compactCount(friendsNoMatch)}
                hint="friends with none"
                isLoading={isLoading}
              />
              <StatTile
                label="Companies known"
                value={isLoading ? "" : compactCount(connectedCount)}
                hint={data ? `of ${compactCount(data.companiesOnFile)} on file` : undefined}
                isLoading={isLoading}
              />
            </div>

            {/*
              Straight under the headline tiles, which is where a reader looks for "what is this
              database made of" — and above the company list rather than below it, because the list
              is the drill-down and a summary that sits under its own detail gets read as a
              footnote. It is outside the dimmed wrappers on both sides of it; see the comment above.
            */}
            <RunMix />

            {/* The fade goes INSIDE this one, onto the rows — see `ConnectedCompanies`. A wrapper
                here would dim the count line and the sort while a page is in flight, which says
                "recomputing" about two controls that are not. */}
            <ConnectedCompanies
              isLoading={isLoading}
              isFetching={isFetching}
              connected={data?.connected ?? []}
              companiesOnFile={data?.companiesOnFile ?? 0}
              pagination={data?.connectedPagination}
              query={companyQuery}
              onClearQuery={() => setCompanyQuery("")}
              sort={sort}
              onSortChange={setSort}
              page={page}
              onPageChange={setPage}
              uploader={uploader}
              threshold={threshold}
              onRunComparison={compareCompany}
            />
          </div>
        )}
      </div>

      {/*
        THE RUN LIST THAT STOOD HERE IS NOW THE RESULTS TAB.

        It was the runs with no page of their own — unscoped ones plus the import-shaped `upload`
        and `file` ones — narrowed that way to avoid double-listing the runs that already appear on
        a company's or an owner's page. As a footer under the company list it read as bookkeeping,
        and the narrowing meant the one place you could scan "what have we run" showed a subset
        chosen by an implementation detail. It is a tab of its own now, unfiltered, with the re-run
        action on every row. See `ResultsTab`.

        What stays here is the network snapshot: tiles, run mix, companies. This tab answers "what
        does my network look like", and a list of runs was never part of that answer.
      */}

      {/*
        ONE DIALOG, ONE ENTRY POINT LEFT ON THIS TAB — the per-company row action. It had three
        until the header button was removed; the shape stays because the row action alone still
        needs it, and a second instance per row would be a second copy of the reset logic and the
        duplicate check, and (with a modal) a stack of them mounted behind each other.

        `scope` is what makes the difference, and `key` is what makes the difference stick: the
        dialog seeds its controls in an effect keyed on `open`, so re-opening it on a different
        company with the same instance would carry the previous scope's state into a dialog whose
        heading had already changed. Remounting per scope is the cheap, obvious fix and costs
        nothing — this component is not mounted until it is opened. The scope IS the whole request
        now: every row here opens a `company` scope of its own value, so no two rows share a key.
      */}
      <NewComparisonDialog
        key={
          compareRequest?.scope
            ? `${compareRequest.scope.filterBy}:${compareRequest.scope.filterValue}`
            : "all"
        }
        open={compareOpen}
        onOpenChange={(next) => {
          setCompareOpen(next);
          if (!next) setCompareRequest(undefined);
        }}
        scope={compareRequest?.scope}
        initial={compareRequest?.initial}
      />
    </div>
  );
}

/**
 * ONE BOX, TWO QUESTIONS — the tab's whole query surface, and what replaced the roster combobox and
 * the "Find connections" button that used to share the header row.
 *
 * ── Why one box and not two controls ──
 *
 * A reader arriving here has a name in their head, and they do not reliably know which KIND of name
 * it is. "Mint" is an owner; "TRUE CORPORATION" is a company; a good half of this database's
 * company names are people's names, and Thai given names appear on both sides. The old pairing made
 * the reader classify their own string before they were allowed to type it: guess wrong and you got
 * an empty company list with a roster picker sitting beside it, already open on a list of exactly
 * the answer you wanted, and no indication that was where to look.
 *
 * So the string goes to both and the ANSWERS come back separately, which is the part that has to
 * stay honest. It is not one merged result list:
 *
 *   · The COMPANY half is the list below, live, on every pause. Nothing to accept — you type and
 *     the list narrows. This is exactly what the old company search box did, unchanged.
 *   · The OWNER half is a SUGGESTION, in a popover, that does nothing until it is chosen. Choosing
 *     one is a state change with real reach — it re-grades every tile on the tab — so it must be an
 *     act, never a side effect of a keystroke.
 *
 * That asymmetry is deliberate and is the design. A single ranked list mixing "3 companies" with
 * "1 owner" would have to decide which is more relevant to a two-letter prefix, and it would be
 * wrong often enough that the reader stopped trusting either half.
 *
 * ── The chip, and why the text clears when an owner is picked ──
 *
 * A chosen owner leaves the box and becomes a chip beside it. The box is then empty and the company
 * list is unfiltered, which is right: an owner's name is not a company name, and leaving "mint" in
 * the box would filter the company list to companies spelled like a person while claiming to show
 * that person's whole reach. Two searches ANDed together, only one of them visible as a search.
 *
 * The chip carries its own dismiss and is the only thing on screen that says a filter is on, which
 * is why `showQuery` refuses to hide this bar while one is — see there.
 */
function NetworkQuery({
  value,
  onValueChange,
  owner,
  onOwnerChange,
  ownerMatches,
  ownerMatchTotal,
  ownersLoading,
}: {
  /** The RAW text, not the debounced one — this is what the box displays, and a box showing a value
   *  300ms behind the keys is a box that feels broken. */
  value: string;
  onValueChange: (v: string) => void;
  /** Whose friends the whole tab is filtered to, or null for everyone. */
  owner: string | null;
  onOwnerChange: (owner: string | null) => void;
  /** One page of the owners matching the debounced text. A capped slice — see `ownerMatchTotal`. */
  ownerMatches: readonly string[];
  /** How many owners matched server-side. Stated when it exceeds the page, never silently dropped. */
  ownerMatchTotal: number;
  ownersLoading: boolean;
}) {
  /**
   * Escape (or an outside click) closes the suggestions WITHOUT clearing the box.
   *
   * The two are separate answers and both are wanted: "I meant a company, stop offering me people"
   * has to leave the company search running. Reset on the next keystroke, so dismissing once does
   * not mute the suggestions for the rest of the session.
   */
  const [dismissed, setDismissed] = React.useState(false);
  /** Keyboard position in the suggestions. -1 is "none", and it is the resting state on purpose:
   *  Enter must not pick an owner the reader never moved onto, since the list below is already
   *  answering the same string live. */
  const [active, setActive] = React.useState(-1);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  // Stable ids so the input can point `aria-activedescendant` at the highlighted row. Without it a
  // screen reader hears nothing as the arrows move: focus never leaves the input, so the only way
  // the moving highlight is announced is by naming the row it landed on.
  const listId = "network-query-owners";
  const optionId = (i: number) => `${listId}-${i}`;

  const text = value.trim();
  // Never suggest the filter that is already on — it is a chip two inches to the right, and a row
  // that does nothing when pressed is worse than no row.
  const suggestions = React.useMemo(
    () => ownerMatches.filter((o) => o !== owner),
    [ownerMatches, owner]
  );

  // A fresh string is a fresh list and a fresh chance to suggest. Both resets belong to the same
  // event, so they share an effect rather than racing as two.
  React.useEffect(() => {
    setActive(-1);
    setDismissed(false);
  }, [value]);

  /**
   * Open only when there is something to say. Not while `ownersLoading` with nothing yet: the
   * request fires on the same debounce as the company list, so an "opening on every pause to show
   * a spinner" popover would flicker over the tiles on the way to "no owners match" — which is the
   * common case, since most of what gets typed here is a company.
   */
  const open = text.length > 0 && !dismissed && suggestions.length > 0;

  const pick = (name: string) => {
    onOwnerChange(name);
    // The text BECAME the filter — see the header. Also collapses the popover, since `text` is now
    // empty; `dismissed` is belt-and-braces for the frame before that lands.
    onValueChange("");
    setDismissed(true);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      // Not `preventDefault`: if the box is empty there is nothing to dismiss and Escape should go
      // on being whatever the browser makes of it.
      if (open) e.preventDefault();
      setDismissed(true);
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next =
        e.key === "ArrowDown"
          ? Math.min(active + 1, suggestions.length - 1)
          : Math.max(active - 1, -1);
      setActive(next);
      // The list caps at a screen and scrolls; an `aria-activedescendant` pointing at a row nobody
      // can see is the sighted half of the same bug. Same move `Combobox` makes.
      if (next >= 0) {
        listRef.current?.querySelectorAll("[data-option]")[next]?.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      pick(suggestions[active]!);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/*
        `Popover` with an explicit `PopoverAnchor` rather than a `PopoverTrigger`, because the input
        is not a trigger: pressing it must put a caret in it, not toggle a menu. The anchor supplies
        the position and `--radix-popover-trigger-width` and nothing else, so `open` stays entirely
        ours — driven by what the reader typed and what came back.
      */}
      <Popover open={open} onOpenChange={(next) => !next && setDismissed(true)}>
        <PopoverAnchor asChild>
          <div className="relative w-full sm:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={value}
              onChange={(e) => onValueChange(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search a company, or a name to filter by…"
              className="h-9 pl-9 pr-9"
              aria-label="Search companies on file, or an owner to filter by"
              role="combobox"
              aria-expanded={open}
              aria-autocomplete="list"
              // Both conditional on `open`, because the listbox is only mounted then: an
              // `aria-controls` or an `aria-activedescendant` naming an element that is not in the
              // document is a broken reference, which reads worse than an absent one.
              aria-controls={open ? listId : undefined}
              aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
              autoComplete="off"
            />
            {/* One spinner slot, one clear button, same corner — they cannot both be true, because
                a request only exists while there is text and clearing removes the text. */}
            {ownersLoading && text.length > 0 ? (
              <Loader2
                className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
                aria-hidden
              />
            ) : (
              value.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    onValueChange("");
                    inputRef.current?.focus();
                  }}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )
            )}
          </div>
        </PopoverAnchor>

        <PopoverContent
          /* The caret stays in the input — the popover is a list of offers, not a place to be. All
             of its keyboard model is on the input's `onKeyDown` above for the same reason. */
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={() => setDismissed(true)}
          className="w-[var(--radix-popover-trigger-width)] min-w-[16rem]"
        >
          <p className="px-2 pb-1 pt-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Filter to one person&rsquo;s friends
          </p>
          <div
            id={listId}
            ref={listRef}
            role="listbox"
            aria-label="Relationship owners matching your search"
            className="max-h-64 overflow-y-auto"
          >
            {suggestions.map((name, i) => (
              <button
                key={name}
                id={optionId(i)}
                data-option
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(name)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none",
                  i === active && "bg-accent text-accent-foreground"
                )}
              >
                <UserSearch className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate" title={name}>
                  {name}
                </span>
              </button>
            ))}
          </div>
          {/* Never silent about a cap — the same rule `Combobox` follows, and for the same reason: a
              truncated list that looks complete reads as "that person is not on file". */}
          {ownerMatchTotal > ownerMatches.length && (
            <p className="border-t px-2 py-1.5 text-xs text-muted-foreground">
              Showing {ownerMatches.length} of {ownerMatchTotal.toLocaleString()} — keep typing to
              narrow.
            </p>
          )}
        </PopoverContent>
      </Popover>

      {/*
        THE ONLY THING ON SCREEN THAT SAYS A FILTER IS ON. Worded rather than abbreviated — "Mint's
        friends" is what the tab is now showing, where a bare "Mint" beside a search box reads as
        something that was searched for.
      */}
      {owner && (
        <Badge variant="default" className="h-9 gap-1.5 rounded-md px-2.5 text-sm">
          <UserSearch className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="max-w-[14rem] truncate" title={owner}>
            {owner}&rsquo;s friends
          </span>
          <button
            type="button"
            onClick={() => onOwnerChange(null)}
            aria-label={`Stop filtering to ${owner} — show everyone's friends`}
            title="Show everyone's friends"
            className="-mr-0.5 rounded-sm p-0.5 opacity-70 outline-none transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </Badge>
      )}
    </div>
  );
}

/**
 * The companies — every one on file, each showing what this roster reaches into it, one screen at a
 * time, with the controls that make the rest reachable.
 *
 * ── A row with no connections is a ROW ──
 *
 * The list was the reached companies only, and the companies nobody reaches were the interesting
 * half: "we hold contacts at 412 companies and your friends get you into 3" is a fact this tab
 * stated in a tile and then declined to itemise. Those rows carry a neutral "no connections" badge
 * rather than the amber one a zero would otherwise pick up (see `reachBadgeVariant`) — the absence
 * of a connection is not a warning about the quality of one — and they stay pressable, because the
 * company page behind them lists the contacts and offers the comparison that would fill the row in.
 *
 * ── Why the list is paged and the tiles are not ──
 *
 * Every number above this list is a tally over the whole roster; this is a list of rows, and rows
 * are the only thing here whose count is unbounded. Paging it is therefore the one change that
 * bounds the payload without making any statement on the tab less true — and the reason
 * `companiesKnown` arrives as its own field: the tile still reports the roster's reach while the
 * list below shows twenty companies out of everything on file.
 *
 * ── Search and sort are SERVER-side, and that is the whole point ──
 *
 * Both are request parameters (see `OverviewTab`). A search box that filtered the twenty rows in
 * hand would answer "is BANGKOK BANK on page one", which is not a question anybody has; the sort
 * has the same defect in a subtler form — "A–Z" over one page is alphabetical within an arbitrary
 * slice, and the reader has no way to see that it is.
 *
 * ── THE SEARCH BOX IS NOT IN HERE ANY MORE (2026-08-06) ──
 *
 * It moved up to `NetworkQuery`, above the tiles, when it grew a second job (owners). This still
 * takes `query` — it needs it to tell "no company is spelled like that" apart from "no company data
 * has been imported", and those are different pages with different ways out — but it can now only
 * CLEAR it, never set it. That is the honest shape: one box on the tab, one owner of its text.
 */
function ConnectedCompanies({
  isLoading,
  isFetching,
  connected,
  companiesOnFile,
  pagination,
  query,
  onClearQuery,
  sort,
  onSortChange,
  page,
  onPageChange,
  uploader,
  threshold,
  onRunComparison,
}: {
  isLoading: boolean;
  /** A newer answer is on the way — the rows dim rather than blank, so a threshold drag or a page
   *  turn has something to move. The controls above them deliberately do not. */
  isFetching: boolean;
  /** One page of the companies, in the order `sort` asked for — including the ones this roster
   *  reaches nowhere near, at `connections: 0`. */
  connected: CompanyConnection[];
  /** How many companies exist, which is what the list runs to. Decides whether the controls are
   *  worth their space (see `CONTROLS_MIN`) and is the denominator the summary line states, both
   *  of which have to be immune to the search — hence this and not `pagination.total`. */
  companiesOnFile: number;
  /** Where the page sits; `total` is how many companies match the search. Undefined until the
   *  first payload lands. */
  pagination?: { page: number; limit: number; total: number; totalPages: number };
  /** What the query bar above currently holds. Read-only here — it decides which empty state this
   *  shows and gets quoted back in it. The box that owns it is `NetworkQuery`. */
  query: string;
  /** Empty the query bar, for the "no company matches" escape hatch. The only write this component
   *  has on the search, deliberately — see the header. */
  onClearQuery: () => void;
  sort: CompanySort;
  onSortChange: (s: CompanySort) => void;
  page: number;
  onPageChange: (p: number) => void;
  /** Whose friends the page is filtered to, or null for everyone. Read only by the per-row query
   *  button, whose meaning it changes — see the comment there. */
  uploader: string | null;
  /** Hung on every company link, so the company page opens at the bar this count was taken at.
   *  Without it a row reading "3 connections" would open on a page listing twelve. */
  threshold: number | null;
  /** Open the run dialog for one company row. How that becomes a scope depends on whether the page
   *  is filtered to a roster — see `compareCompany`, which this is. */
  onRunComparison: (company: string) => void;
}) {
  const { canWrite } = usePermissions();
  const searching = query.trim().length > 0;
  const totalPages = pagination?.totalPages ?? 0;
  const matches = pagination?.total ?? 0;
  // Measured on what is on file, never on what is on screen — see CONTROLS_MIN. Held back while the
  // first payload is in flight so the controls do not appear over a skeleton and then vanish.
  // `searching` keeps them up regardless: the count line is how the reader learns their search
  // matched 3 of 412, and it must not disappear at the moment it becomes the interesting number.
  const showControls = !isLoading && (searching || companiesOnFile >= CONTROLS_MIN);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[52px] rounded-lg" />
        ))}
      </div>
    );
  }

  // Nothing to LIST — no company data has been imported at all. It used to be `companiesKnown === 0`
  // ("the roster reaches nowhere"), and that state is now a list of companies each reading "no
  // connections", which says the same thing and names the companies while it does. What is left is
  // the case where there is genuinely nothing to show a row for, and the way out of it is an import
  // rather than a run: a comparison with no contacts on the other side has nothing to score against.
  //
  // Distinct from a search that found nothing, below — that one is escaped by clearing the box.
  // Keyed on the list being empty rather than on `companiesOnFile === 0`, so that an empty list is
  // never rendered as a search miss for a search nobody typed ("No company matches """).
  if (!searching && connected.length === 0) {
    return (
      <EmptyState
        icon={Building2}
        title="No company data yet"
        description={
          canWrite
            ? "Import a company list and this becomes every company on file, with the friends who reach each one."
            : "No company data has been imported yet, so there is nothing for your friends to be matched against."
        }
        action={
          canWrite ? (
            <Button asChild variant="outline" size="sm">
              <Link href="/uploads">Import data</Link>
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      {showControls && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* What the list is currently showing, in words, because two of the three things that
              decide it (the search and the page) are not visible in the rows themselves. It leads
              the row now that the search box has moved up to `NetworkQuery` — this line is the
              closest thing left to a statement of what was asked. The denominator is what is ON
              FILE, which is what the list runs to — a bare "3 companies" over a filtered list reads
              as a database holding three. `companiesKnown` is deliberately not stated here: it is
              the tile directly above, and repeating it over the list would put two different
              numbers a foot apart, both labelled "companies". */}
          <p className="text-sm tabular-nums text-muted-foreground">
            {searching
              ? `${matches.toLocaleString()} of ${companiesOnFile.toLocaleString()} companies`
              : `${matches.toLocaleString()} companies`}
          </p>
          <CompanySortToggle sort={sort} onChange={onSortChange} />
        </div>
      )}

      {connected.length === 0 ? (
        /* The search found nothing. NOT the "no company data" state above: companies are on file,
           just none spelled like this — so the way out is to clear the box, not to import. And
           since the list searches everything on file rather than only the reached companies, a miss
           here now means the company genuinely is not in the database. */
        <EmptyState
          icon={SearchX}
          title={`No company matches “${query.trim()}”`}
          description="No company on file is spelled like that — try a shorter spelling, or clear the search. If you meant a person, the box above offers them as a filter."
          action={
            <Button variant="outline" size="sm" onClick={onClearQuery}>
              Clear search
            </Button>
          }
        />
      ) : (
        <div
          className={cn(
            "overflow-hidden rounded-lg border transition-opacity",
            isFetching && !isLoading && "opacity-60"
          )}
        >
          {connected.map((c) => (
            /*
              THE ROW IS A LINK AND THE BUTTON IS NOT — which is why the link is no longer the row.

              It used to be a `<Link>` wrapping everything. Nesting a button inside one is invalid
              HTML and behaves like it: the anchor swallows the click, so "Compare" would navigate.
              The fix is the pattern this codebase already uses in `RecentRuns` — an ordinary
              container, with the link stretched over it by a pseudo-element, and anything
              interactive lifted above it with `relative z-10`. The whole row stays clickable and
              the button stays a button.
            */
            <div
              key={c.company}
              className="group relative flex items-center gap-3 border-b p-4 transition-colors last:border-b-0 hover:bg-muted/40 focus-within:bg-muted/40"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                <Building2 className="h-4 w-4" />
              </div>
              <Link
                href={withThreshold(`/companies/${encodeURIComponent(c.company)}`, threshold)}
                className="min-w-0 flex-1 truncate font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline"
              >
                {c.company}
              </Link>
              {/* Amber when every one of these connections is a lead — the "BANGKOK BANK · 12
                  connections" case, where a dozen surname hits read as a dozen placements. Neutral
                  at zero, and worded rather than counted: "No connections" is what the row is
                  telling you, where "0 connections" makes the reader parse a number to find out. */}
              <Badge
                variant={reachBadgeVariant(c.confirmed, c.connections)}
                className={cn("shrink-0", c.connections === 0 && "text-muted-foreground")}
                title={companyReachTitle(c.connections, c.confirmed)}
              >
                <Link2 className="h-3 w-3" />
                {c.connections === 0
                  ? "No connections"
                  : `${c.connections} connection${c.connections === 1 ? "" : "s"}`}
                <ReachLeads connections={c.connections} confirmed={c.confirmed} />
              </Badge>
              {/*
                Run & compare THIS company again — the row-level version of the header's button, and
                the reason the scope axis exists.

                Icon-only and revealed on hover, like the delete in `RecentRuns`: it is a secondary
                action on a row whose primary action is "go and look at this company", and a labelled
                button on every row would compete with the connection count for the eye. The
                `aria-label` names the company so it is not one of twenty identical buttons to a
                screen reader, and `focus-visible:opacity-100` keeps it reachable by keyboard.

                IT INHERITS THE ROSTER FILTER, which is why the label has to name it: the same press
                asks about everybody's friends or about one person's depending on a control at the
                top of the page, and that is precisely the kind of thing a row action must not do
                silently. The dialog states it again in its heading, before anything is spent.

                Writers only — a run writes rows, and a reviewer reads the network rather than
                extending it. Same rule as the header button above.
              */}
              {canWrite && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={
                    uploader
                      ? `Run & compare ${uploader}'s friends at ${c.company}`
                      : `Run & compare every friend at ${c.company}`
                  }
                  title={
                    uploader
                      ? `Score ${uploader}'s friends against the contacts at ${c.company}`
                      : `Score every friend on file against the contacts at ${c.company}`
                  }
                  onClick={() => onRunComparison(c.company)}
                  className="relative z-10 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <GitCompareArrows className="h-4 w-4" />
                </Button>
              )}
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
          ))}
        </div>
      )}

      <Pager
        page={page}
        totalPages={totalPages}
        onPageChange={onPageChange}
        label="companies"
        // The rows dim, and the summary says why. The dim alone is easy to miss on a fast read and
        // says nothing at all to a screen reader.
        pending={isFetching && !isLoading}
        summary={`Page ${page.toLocaleString()} of ${totalPages.toLocaleString()} · ${matches.toLocaleString()} compan${
          matches === 1 ? "y" : "ies"
        }`}
      />
    </div>
  );
}

/**
 * Reach, or the alphabet.
 *
 * A segmented control rather than a dropdown, for the same reason the run table's row order is one:
 * there are two options, both are legitimate readings of the same list, and neither modifies the
 * other — so the cheapest thing to render is also the only one that shows what the other choice is
 * without being opened.
 *
 * "Most connections" stays the default because it is the finding. "A–Z" is what you switch to when
 * you have arrived with a company already in mind and are checking whether it is here — the same
 * job the search box does, for a reader who would rather scan than type.
 */
function CompanySortToggle({
  sort,
  onChange,
}: {
  sort: CompanySort;
  onChange: (s: CompanySort) => void;
}) {
  const options: { value: CompanySort; label: string }[] = [
    { value: "connections", label: "Most connections" },
    { value: "name", label: "A–Z" },
  ];

  return (
    <div
      role="group"
      aria-label="Company order"
      className="inline-flex shrink-0 rounded-lg border bg-muted p-0.5"
    >
      {options.map((o) => {
        const active = sort === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={cn(
              "inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium",
              "transition-colors duration-fast ease-swift",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              active ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
