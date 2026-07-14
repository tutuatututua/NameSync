"use client";

import * as React from "react";
import { Building2, GitMerge, Search, SearchX, Users } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { ConfidenceBadge } from "@/components/confidence/ConfidenceBadge";
import {
  CONFIDENCE_TIERS,
  confidenceBar,
  confidenceClasses,
  confidenceLabel,
  getConfidenceTier,
  isMatch,
  type ConfidenceTier,
} from "@/lib/confidence";
import type { MatchRow } from "@/lib/match";
import { cn } from "@/lib/utils";

/**
 * The evidence behind the verdict.
 *
 * Two things about this table were wrong, and they were the same thing twice. The matcher
 * keeps a best guess for *every* friend however bad, so a run's rows are the friend list —
 * and this opened on all of them, unsorted. The first screen of a 320-row run was therefore
 * whichever friends happened to be inserted first, at whatever score, and the dozen people
 * the run actually found were somewhere below the fold behind a filter chip you had to know
 * to press. The default is now the matches, sorted best first; the strangers are one click
 * away, where they belong, because "who did NOT match" is a real question and this is the
 * only place that answers it.
 *
 * The columns are in two tiers, because a row here is two records stapled together by a fuzzy
 * score and reads as one: the top tier names the *source* each block came from and the table
 * it came out of, and a rule down the left of each block keeps the grouping visible once the
 * header has scrolled.
 */

/** Above this, we stop rendering rows and say so. Only ever hit in the "all scored" scope. */
const MAX_ROWS = 300;

/** The vertical rule that opens each source block. */
const DIVIDER = "border-l border-l-border-strong";

type Scope = "matches" | "all";

const cell = (v: unknown): string =>
  v === null || v === undefined || v === "" ? "—" : String(v);

export function MatchTable({
  rows,
  company,
  scoredCount,
}: {
  rows: MatchRow[];
  company: string | null;
  /** How many names the run looked at, which can exceed the rows we hold. */
  scoredCount?: number;
}) {
  const [scope, setScope] = React.useState<Scope>("matches");
  const [query, setQuery] = React.useState("");
  const [tiers, setTiers] = React.useState<Set<ConfidenceTier>>(new Set());

  // An external matcher can put fields of its own in `extra`; those still get columns.
  const extraKeys = React.useMemo(() => {
    const keys = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r.extras)) keys.add(k);
    return [...keys].sort();
  }, [rows]);

  // Best first. The API returns rows in insertion order, which is meaningless to a reader —
  // and actively misleading at the top of a table whose whole subject is "how close is this?".
  const sorted = React.useMemo(
    () => [...rows].sort((a, b) => b.score - a.score),
    [rows]
  );

  const matchCount = React.useMemo(() => rows.filter((r) => isMatch(r.score)).length, [rows]);

  const counts = React.useMemo(() => {
    const c: Record<ConfidenceTier, number> = { high: 0, good: 0, medium: 0, low: 0 };
    for (const r of rows) c[getConfidenceTier(r.score)]++;
    return c;
  }, [rows]);

  const inScope = React.useMemo(
    () => (scope === "matches" ? sorted.filter((r) => isMatch(r.score)) : sorted),
    [sorted, scope]
  );

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return inScope.filter((r) => {
      // Tiers only refine the "all scored" scope — see the chip block below.
      if (scope === "all" && tiers.size > 0 && !tiers.has(getConfidenceTier(r.score))) return false;
      if (!needle) return true;
      return [r.fbName, r.uploadedBy, r.personEn, r.personTh, company].some((v) =>
        (v ?? "").toLowerCase().includes(needle)
      );
    });
  }, [inScope, query, tiers, scope, company]);

  function toggleTier(t: ConfidenceTier) {
    setTiers((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  function switchScope(next: Scope) {
    setScope(next);
    // A tier filter set while browsing everything would silently survive into the matches
    // view, where it can only subtract — leaving a "Matches (13)" tab showing four rows.
    if (next === "matches") setTiers(new Set());
  }

  const matchCols = 1 + extraKeys.length; // similarity, + any fields an external matcher sent
  const colCount = 4 + matchCols;

  /**
   * Is there anything to switch *to*?
   *
   * The internal matcher keeps a row per name it scores, so "All scored" is a real, larger
   * list — the near-misses, and the answer to "why didn't X match?". An external workflow is
   * only obliged to write back the rows that *matched*, and then every row we hold is a match:
   * "All scored" would be the same list under a different name, and its count would claim the
   * run only ever looked at the people it found.
   *
   * So the toggle appears when the other view exists, and not when it doesn't.
   */
  const hasNonMatches = rows.length > matchCount;
  const unstoredCount = Math.max((scoredCount ?? rows.length) - rows.length, 0);

  // Nothing to score at all is not the same as nothing matching a filter, and the controls
  // would have nothing to act on — every tier and both scopes read zero.
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No rows to show"
        description="This comparison produced nothing: there were no named Facebook friends to score against the company."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {hasNonMatches && (
            <ScopeToggle
              scope={scope}
              onChange={switchScope}
              matchCount={matchCount}
              total={rows.length}
            />
          )}

          <div className="relative w-full sm:max-w-xs">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search names…"
              className="pl-9"
              aria-label="Search results"
            />
          </div>
        </div>

        {/* Tier chips refine the full list — they are meaningless in the matches scope, where
            two of the four tiers are by definition empty and pressing them would only ever
            take rows away from a list the user just asked to see whole. */}
        {scope === "all" && (
          <div className="flex flex-wrap items-center gap-1.5">
            {CONFIDENCE_TIERS.map((t) => {
              const active = tiers.has(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleTier(t)}
                  aria-pressed={active}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded border px-2 py-1 text-2xs font-medium",
                    "transition-colors duration-fast ease-swift",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                    active
                      ? confidenceClasses[t]
                      : "border-border-strong text-muted-foreground hover:bg-muted"
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", confidenceBar[t])} aria-hidden />
                  {confidenceLabel[t]}
                  <span className="tabular-nums opacity-60">{counts[t].toLocaleString()}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyResult
          scope={scope}
          query={query.trim()}
          tiers={tiers}
          onShowAll={() => switchScope("all")}
        />
      ) : (
        <>
          {/* Below `md` the table is unusable: five columns in 390px push Similarity — the
              one column the reader came for — off the right edge, behind a horizontal scroll
              they have no reason to suspect. A row is a pair plus a score, so on a phone it
              is rendered as exactly that. */}
          <ul className="space-y-2 md:hidden">
            {filtered.slice(0, MAX_ROWS).map((r) => (
              <MatchCard key={r.id} row={r} company={company} extraKeys={extraKeys} />
            ))}
          </ul>

          <div className="hidden overflow-hidden rounded-lg border md:block">
            <Table containerClassName="max-h-[34rem]">
              <TableHeader>
                {/* Tier one: where the columns beneath came from. `bg-muted` and not a tint —
                    a sticky header scrolls content underneath itself, so its cells have to be
                    opaque or the rows show through them. */}
                <TableRow className="hover:bg-transparent">
                  <TableHead colSpan={2} className="border-b-2 border-b-brand bg-muted">
                    <span className="inline-flex items-center gap-1.5 text-foreground">
                      <Building2 className="h-3 w-3" aria-hidden />
                      <span className="max-w-[12rem] truncate">{company ?? "Company"}</span>
                      <code className="ml-1 font-mono text-2xs normal-case tracking-normal text-muted-foreground">
                        company_contact
                      </code>
                    </span>
                  </TableHead>

                  <TableHead
                    colSpan={2}
                    className={cn("border-b-2 border-b-brand-2 bg-muted", DIVIDER)}
                  >
                    <span className="inline-flex items-center gap-1.5 text-foreground">
                      <Users className="h-3 w-3" aria-hidden /> Facebook
                      <code className="ml-1 font-mono text-2xs normal-case tracking-normal text-muted-foreground">
                        friend
                      </code>
                    </span>
                  </TableHead>

                  <TableHead
                    colSpan={matchCols}
                    className={cn("border-b-2 border-b-border-strong bg-muted", DIVIDER)}
                  >
                    <span className="inline-flex items-center gap-1.5 text-foreground">
                      <GitMerge className="h-3 w-3" aria-hidden /> Match
                    </span>
                  </TableHead>
                </TableRow>

                <TableRow className="hover:bg-transparent">
                  <TableHead>English name</TableHead>
                  <TableHead>Thai name</TableHead>
                  <TableHead className={DIVIDER}>Friend</TableHead>
                  <TableHead>Uploaded by</TableHead>
                  {/* The rule opens the Match block, so it belongs to whichever column comes
                      first in it — the extras, when an external matcher sent any. */}
                  {extraKeys.map((k, i) => (
                    <TableHead key={k} className={cn(i === 0 && DIVIDER)}>
                      {k.replace(/_/g, " ")}
                    </TableHead>
                  ))}
                  <TableHead className={cn("text-right", extraKeys.length === 0 && DIVIDER)}>
                    Similarity
                  </TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {filtered.slice(0, MAX_ROWS).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium text-foreground">{cell(r.personEn)}</TableCell>
                    <TableCell className="font-thai">{cell(r.personTh)}</TableCell>
                    <TableCell className={DIVIDER}>{cell(r.fbName)}</TableCell>
                    <TableCell className="text-muted-foreground">{cell(r.uploadedBy)}</TableCell>
                    {extraKeys.map((k, i) => (
                      <TableCell
                        key={k}
                        className={cn("text-muted-foreground", i === 0 && DIVIDER)}
                      >
                        {cell(r.extras[k])}
                      </TableCell>
                    ))}
                    <TableCell className={cn("text-right", extraKeys.length === 0 && DIVIDER)}>
                      <ConfidenceBadge score={r.score} />
                    </TableCell>
                  </TableRow>
                ))}

                {filtered.length > MAX_ROWS && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell
                      colSpan={colCount}
                      className="bg-muted/30 text-center text-xs text-muted-foreground"
                    >
                      Showing the {MAX_ROWS} closest of {filtered.length.toLocaleString()} rows —
                      narrow the search to see the rest.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {filtered.length > MAX_ROWS && (
            <p className="text-center text-xs text-muted-foreground md:hidden">
              Showing the {MAX_ROWS} closest of {filtered.length.toLocaleString()} rows — narrow
              the search to see the rest.
            </p>
          )}

          {/* The run looked at more names than this table holds. Saying so is the difference
              between "these are the matches" and "these are all the names" — and the second
              would be a claim that the run had a 100% hit rate. */}
          {unstoredCount > 0 && (
            <p className="text-xs text-muted-foreground">
              The other {unstoredCount.toLocaleString()}{" "}
              {unstoredCount === 1 ? "name" : "names"} in this import matched nobody and{" "}
              {unstoredCount === 1 ? "was" : "were"} not kept — only matches are stored.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Matches, or everything.
 *
 * A segmented control rather than a checkbox because these are two ways to read the same run,
 * both legitimate, and neither is a modifier on the other: "who matched" is the finding, and
 * "who didn't" is how you check it. Both carry their count, so the cost of the other view is
 * visible before you press it.
 */
function ScopeToggle({
  scope,
  onChange,
  matchCount,
  total,
}: {
  scope: Scope;
  onChange: (s: Scope) => void;
  matchCount: number;
  total: number;
}) {
  const options: { value: Scope; label: string; count: number }[] = [
    { value: "matches", label: "Matches", count: matchCount },
    { value: "all", label: "All scored", count: total },
  ];

  return (
    <div
      role="group"
      aria-label="Which rows to show"
      className="inline-flex shrink-0 rounded-lg border bg-muted p-0.5"
    >
      {options.map((o) => {
        const active = scope === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium",
              "transition-colors duration-fast ease-swift",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              active
                ? "bg-card text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {o.label}
            <span className={cn("tabular-nums", active ? "text-muted-foreground" : "opacity-60")}>
              {o.count.toLocaleString()}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** One row, on a phone: the pair, who brought it, and the score — nothing off-screen. */
function MatchCard({
  row,
  company,
  extraKeys,
}: {
  row: MatchRow;
  company: string | null;
  extraKeys: string[];
}) {
  return (
    <li className="space-y-3 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          {/* Company first, then Facebook — the column order of the table this replaces. */}
          <div className="min-w-0">
            <p className="truncate text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              {company ?? "Company"}
            </p>
            <p className="truncate font-medium">{cell(row.personEn)}</p>
            {row.personTh && (
              <p className="truncate font-thai text-sm text-muted-foreground">{row.personTh}</p>
            )}
          </div>

          <div className="min-w-0">
            <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Facebook
            </p>
            <p className="truncate">{cell(row.fbName)}</p>
          </div>
        </div>

        <ConfidenceBadge score={row.score} className="shrink-0" />
      </div>

      <div className="space-y-0.5 border-t pt-2 text-xs text-muted-foreground">
        <p className="truncate">Uploaded by {cell(row.uploadedBy)}</p>
        {extraKeys.map((k) => (
          <p key={k} className="truncate">
            {k.replace(/_/g, " ")}: {cell(row.extras[k])}
          </p>
        ))}
      </div>
    </li>
  );
}

/** Why the list is empty, and the way out — which differs by what emptied it. */
function EmptyResult({
  scope,
  query,
  tiers,
  onShowAll,
}: {
  scope: Scope;
  query: string;
  tiers: Set<ConfidenceTier>;
  onShowAll: () => void;
}) {
  // The run genuinely found nothing. The rows still exist — they're all below the bar — so
  // the way forward is the other scope, offered as a button rather than described.
  if (scope === "matches" && !query) {
    return (
      <EmptyState
        icon={SearchX}
        title="No matches in this run"
        description="Every friend was scored, but none came close enough to anyone at this company to count as a match."
        action={
          <Button variant="outline" size="sm" onClick={onShowAll}>
            Show all scored friends
          </Button>
        }
      />
    );
  }

  if (query && scope === "matches") {
    return (
      <EmptyState
        icon={Search}
        title={`No match named “${query}”`}
        description="No matching friend or contact has that name. It may still be in the full scored list."
        action={
          <Button variant="outline" size="sm" onClick={onShowAll}>
            Search all scored friends
          </Button>
        }
      />
    );
  }

  return (
    <EmptyState
      icon={Search}
      title="Nothing matches those filters"
      description={
        tiers.size > 0 && query
          ? "No row matches both the search and the tiers you picked."
          : tiers.size > 0
            ? "No row falls in the tiers you picked."
            : `No name contains “${query}”.`
      }
    />
  );
}
