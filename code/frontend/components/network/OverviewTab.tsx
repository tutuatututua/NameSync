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
import { useNetworkOverview } from "@/hooks/queries";

/** Radix Select can't hold an empty value, so "everyone" needs a stand-in. */
const EVERYONE = "__everyone__";

/**
 * Overview (Feature 1) — the home tab: a roster's reach across every company, plus the run history.
 *
 * Answers the client's "how many companies did the user match / not match" and "how many friends
 * did they upload": pick whose friends (an uploader, or everyone) and read the tiles. It reads
 * stored results — with the external matcher every import auto-matches, so this fills in on its
 * own; the "Find connections" action is the occasional ad-hoc case and hands off to the run's page.
 */
export function OverviewTab() {
  const [uploader, setUploader] = React.useState<string | null>(null);
  const [compareOpen, setCompareOpen] = React.useState(false);
  const { data, isLoading } = useNetworkOverview(uploader);

  const connectedCount = data?.connected.length ?? 0;
  const friends = data?.friends ?? 0;
  const friendsMatched = data?.friendsMatched ?? 0;
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
              <Button variant="outline" size="sm" onClick={() => setCompareOpen(true)}>
                <GitCompareArrows className="h-4 w-4" /> Find connections
              </Button>
            </div>
          }
        />

        {nothingYet ? (
          <EmptyState
            icon={Link2}
            title="Nothing here yet"
            description="Upload a friend list and some company data to see who your network can reach."
            action={
              <Button asChild variant="outline" size="sm">
                <Link href="/uploads">Import data</Link>
              </Button>
            }
          />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label="Friends"
                value={isLoading ? "" : compactCount(friends)}
                hint={uploader ? "on this owner's list" : "uploaded, all owners"}
                isLoading={isLoading}
              />
              <StatTile
                label="Matched"
                value={isLoading ? "" : compactCount(friendsMatched)}
                hint="friends with a connection"
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
              onRunComparison={() => setCompareOpen(true)}
            />
          </>
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
  onRunComparison,
}: {
  isLoading: boolean;
  connected: { company: string; connections: number }[];
  uploader: string | null;
  onRunComparison: () => void;
}) {
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
        description="No comparison so far has turned up a match at any company. Import more data, or run one against specific companies."
        action={
          <Button variant="outline" size="sm" onClick={onRunComparison}>
            <GitCompareArrows className="h-4 w-4" /> Find connections
          </Button>
        }
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      {connected.map((c) => (
        <Link
          key={c.company}
          href={`/companies/${encodeURIComponent(c.company)}`}
          className="group flex items-center gap-3 border-b p-4 outline-none transition-colors last:border-b-0 hover:bg-muted/40 focus-visible:bg-muted/40"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
            <Building2 className="h-4 w-4" />
          </div>
          <p className="min-w-0 flex-1 truncate font-medium">{c.company}</p>
          <Badge variant="success" className="shrink-0">
            <Link2 className="h-3 w-3" />
            {c.connections} connection{c.connections === 1 ? "" : "s"}
          </Badge>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </Link>
      ))}
    </div>
  );
}
