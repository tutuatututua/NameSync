"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Building2, GitCompareArrows, Link2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatTile, compactCount } from "@/components/stat-tile";
import { EmptyState } from "@/components/empty-state";
import { SectionHeader } from "@/components/page-header";
import { RecentRuns } from "@/components/network/RecentRuns";
import { NewComparisonDialog } from "@/components/network/NewComparisonDialog";
import {
  MatchedHint,
  ReachLeads,
  companyReachTitle,
  reachBadgeVariant,
} from "@/components/network/match-grade";
import { usePermissions } from "@/components/auth-provider";
import { useNetworkOverview } from "@/hooks/queries";
import { withThreshold } from "@/hooks/useThreshold";
import { cn } from "@/lib/utils";

/** Radix Select can't hold an empty value, so "everyone" needs a stand-in. */
const EVERYONE = "__everyone__";

/**
 * Overview (Feature 1) — the home tab: a roster's reach across every company, plus the run history.
 *
 * Answers the client's "how many companies did the user match / not match" and "how many friends
 * did they upload": pick whose friends (an uploader, or everyone) and read the tiles. It reads
 * stored results — with the external matcher every import auto-matches, so this fills in on its
 * own; the "Find connections" action is the occasional ad-hoc case and hands off to the run's page.
 *
 * `threshold` is the workspace bar from the page above (null = the matchers' own verdicts). Every
 * number here moves with it EXCEPT `friends`, which counts friend rows — that asymmetry is the
 * point of the tile row: as the bar tightens, Matched falls and No match rises by the same amount,
 * out of a roster that visibly did not change size.
 */
export function OverviewTab({ threshold = null }: { threshold?: number | null }) {
  const [uploader, setUploader] = React.useState<string | null>(null);
  const [compareOpen, setCompareOpen] = React.useState(false);
  const { canWrite } = usePermissions();
  const { data, isLoading, isFetching } = useNetworkOverview(uploader, threshold ?? undefined);

  const connectedCount = data?.connected.length ?? 0;
  const friends = data?.friends ?? 0;
  const friendsMatched = data?.friendsMatched ?? 0;
  const friendsConfirmed = data?.friendsConfirmed ?? 0;
  // Unchanged by the grading, deliberately: leads stay inside `friendsMatched`, so this is still
  // "the roster minus everyone with a connection". Narrowing Matched to confirmed-only would have
  // pushed leads in here and restated a match as a non-match.
  const friendsNoMatch = Math.max(0, friends - friendsMatched);

  // Truly nothing here: no friends uploaded and no company data. Point at Uploads. (A roster with
  // friends but no connections is NOT this — it's a real answer, "you know nobody yet".)
  const nothingYet =
    !isLoading && data && data.uploaders.length === 0 && data.friends === 0 && data.companiesOnFile === 0;

  return (
    <div className="space-y-8">
      <div className="space-y-6">
        <SectionHeader
          title="Your network"
          description="Companies your friends reach, and how many friends you've uploaded."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {data && data.uploaders.length > 0 && (
                <div className="flex items-center gap-2">
                  <Label htmlFor="roster" className="whitespace-nowrap text-sm text-muted-foreground">
                    Whose friends
                  </Label>
                  <Select
                    value={uploader ?? EVERYONE}
                    onValueChange={(v) => setUploader(v === EVERYONE ? null : v)}
                  >
                    <SelectTrigger id="roster" className="h-8 w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={EVERYONE}>Everyone</SelectItem>
                      {data.uploaders.map((u) => (
                        <SelectItem key={u} value={u}>
                          {u}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {/* A run writes: it opens a comparison and fills comparison_result. Reviewers
                  read the network, they don't extend it. */}
              {canWrite && (
                <Button variant="outline" size="sm" onClick={() => setCompareOpen(true)}>
                  <GitCompareArrows className="h-4 w-4" /> Find connections
                </Button>
              )}
            </div>
          }
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
          /* Dimmed, not blanked, while a new bar is in flight: `keepPreviousData` holds the last
             answer on screen so the drag has something to move, and the fade is what stops the
             previous bar's numbers from reading as this bar's. Skipped on the first load, which
             has its own skeletons. */
          <div className={cn("space-y-6 transition-opacity", isFetching && !isLoading && "opacity-60")}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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

            <ConnectedList
              isLoading={isLoading}
              connected={data?.connected ?? []}
              uploader={uploader}
              threshold={threshold}
              onRunComparison={() => setCompareOpen(true)}
            />
          </div>
        )}
      </div>

      <RecentRuns />

      <NewComparisonDialog open={compareOpen} onOpenChange={setCompareOpen} />
    </div>
  );
}

function ConnectedList({
  isLoading,
  connected,
  uploader,
  threshold,
  onRunComparison,
}: {
  isLoading: boolean;
  connected: { company: string; connections: number; confirmed: number }[];
  uploader: string | null;
  /** Hung on every company link, so the company page opens at the bar this count was taken at.
   *  Without it a row reading "3 connections" would open on a page listing twelve. */
  threshold: number | null;
  onRunComparison: () => void;
}) {
  const { canWrite } = usePermissions();

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[52px] rounded-lg" />
        ))}
      </div>
    );
  }

  if (connected.length === 0) {
    return (
      <EmptyState
        icon={Link2}
        title={uploader ? `No connections for ${uploader}` : "No connections found"}
        description={
          canWrite
            ? "No comparison so far has turned up a match at any company. Import more data, or run one against specific companies."
            : "No comparison so far has turned up a match at any company."
        }
        action={
          canWrite ? (
            <Button variant="outline" size="sm" onClick={onRunComparison}>
              <GitCompareArrows className="h-4 w-4" /> Find connections
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      {connected.map((c) => (
        <Link
          key={c.company}
          href={withThreshold(`/companies/${encodeURIComponent(c.company)}`, threshold)}
          className="group flex items-center gap-3 border-b p-4 outline-none transition-colors last:border-b-0 hover:bg-muted/40 focus-visible:bg-muted/40"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
            <Building2 className="h-4 w-4" />
          </div>
          <p className="min-w-0 flex-1 truncate font-medium">{c.company}</p>
          {/* Amber when every one of these connections is a lead — the "BANGKOK BANK · 12
              connections" case, where a dozen surname hits read as a dozen placements. */}
          <Badge
            variant={reachBadgeVariant(c.confirmed)}
            className="shrink-0"
            title={companyReachTitle(c.connections, c.confirmed)}
          >
            <Link2 className="h-3 w-3" />
            {c.connections} connection{c.connections === 1 ? "" : "s"}
            <ReachLeads connections={c.connections} confirmed={c.confirmed} />
          </Badge>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </Link>
      ))}
    </div>
  );
}
