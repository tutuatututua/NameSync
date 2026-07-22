"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Building2, UserCheck, UserX } from "lucide-react";
import type { CompanyMatchGroup, MatchedPerson } from "@extensions/contract";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatTile, compactCount } from "@/components/stat-tile";
import { useNetworkUploader } from "@/hooks/queries";

/**
 * One uploader — every friend they contributed, split into the names their network placed and the
 * names it hasn't.
 *
 * This is the drill-down behind the Uploaders tab and behind every "known by / reached by" chip in
 * the app: the counts were always visible, but the *names* were not, and the names are the point —
 * "which of my friends still has no connection" is the list you act on. Matched friends carry the
 * company they landed at (a link straight to it); the no-match list is just the names, because
 * that is all there is to say about them yet.
 */
export default function UploaderPage() {
  const params = useParams<{ name: string }>();
  const name = decodeURIComponent(String(params.name));
  const { data, isLoading } = useNetworkUploader(name);

  const matched = data?.matchedByCompany ?? [];
  const noMatch = data?.noMatchNames ?? [];
  const nothing = !isLoading && data && data.friends === 0;

  return (
    <div className="space-y-8">
      <PageHeader
        backHref="/?tab=uploaders"
        backLabel="Uploaders"
        title={name}
        description="The friends this person uploaded, and how many their network reaches."
      />

      {isLoading ? (
        <UploaderSkeleton />
      ) : nothing ? (
        <EmptyState
          icon={UserX}
          title="No friends on file for this uploader"
          description="Their roster may have been removed, or the name may be spelled differently."
          action={
            <Link href="/?tab=uploaders" className="text-sm font-medium text-primary hover:underline">
              Back to Uploaders
            </Link>
          }
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile label="Friends" value={compactCount(data?.friends ?? 0)} hint="uploaded by this person" />
            <StatTile
              label="Matched"
              value={compactCount(data?.matched ?? 0)}
              hint="friends with a connection"
              emphasis
            />
            <StatTile label="No match" value={compactCount(data?.noMatch ?? 0)} hint="friends with none" />
          </div>

          <div className="space-y-4">
            <SectionHeader
              title="Matched"
              description="Friends who connect to someone on file, grouped by company."
            />
            {matched.length === 0 ? (
              <EmptyState
                icon={UserCheck}
                title="No matches yet"
                description="None of this person's friends has turned up at a company on file."
              />
            ) : (
              <div className="space-y-4">
                {matched.map((group) => (
                  <CompanyGroup key={group.company} group={group} />
                ))}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <SectionHeader
              title="No match"
              description="Friends with no connection on file yet — the names still to place."
            />
            {noMatch.length === 0 ? (
              <EmptyState
                icon={UserCheck}
                title="Everyone's connected"
                description="Every friend this person uploaded reaches someone on file."
              />
            ) : (
              <div className="flex flex-wrap gap-2 rounded-lg border p-4">
                {noMatch.map((n) => (
                  <Badge key={n} variant="outline" className="text-muted-foreground">
                    {n}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** One company section: a header linking to the company page, then its matched people. */
function CompanyGroup({ group }: { group: CompanyMatchGroup }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <Link
        href={`/companies/${encodeURIComponent(group.company)}`}
        className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2.5 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60"
      >
        <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{group.company}</span>
        <span className="shrink-0 text-sm text-muted-foreground">
          {group.people.length} {group.people.length === 1 ? "person" : "people"}
        </span>
      </Link>
      {group.people.map((p, i) => (
        <MatchedRow key={`${p.friend}-${i}`} person={p} />
      ))}
    </div>
  );
}

/** One matched person — the English name leads (the actionable identity), with the Thai name and
 *  the uploaded friend name beneath it. Falls back to the uploaded name when the contact has no
 *  English spelling on file. */
function MatchedRow({ person }: { person: MatchedPerson }) {
  const primary = person.en || person.friend;
  return (
    <div className="flex items-start gap-3 border-b p-4 transition-colors last:border-b-0 hover:bg-muted/40">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-confidence-high/25 bg-confidence-high/10 text-confidence-high">
        <UserCheck className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate font-medium">{primary}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
          {person.th && <span className="truncate">{person.th}</span>}
          {/* The uploaded friend name — how they appear in this person's own contact list. */}
          <span className="truncate">Uploaded as “{person.friend}”</span>
        </div>
      </div>
    </div>
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
