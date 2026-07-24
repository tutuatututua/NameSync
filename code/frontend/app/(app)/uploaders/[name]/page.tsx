"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Building2, UserCheck, UserX } from "lucide-react";
import type { CompanyMatchGroup, MatchedPerson, NoMatchPerson } from "@extensions/contract";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatTile, compactCount } from "@/components/stat-tile";
import { formatSimilarity } from "@/lib/format";
import { useNetworkUploader } from "@/hooks/queries";

/**
 * One relationship owner — every friend they contributed, split into the names their network placed
 * and the names it hasn't.
 *
 * This is the drill-down behind the Relationship owners tab and behind every "known by / reached
 * by" chip in the app: the counts were always visible, but the *names* were not, and the names are
 * the point —
 * "which of my friends still has no connection" is the list you act on. Matched friends carry the
 * company they landed at (a link straight to it); the no-match list is just the names, because
 * that is all there is to say about them yet.
 */
export default function UploaderPage() {
  const params = useParams<{ name: string }>();
  const name = decodeURIComponent(String(params.name));
  const { data, isLoading } = useNetworkUploader(name);

  const matched = data?.matchedByCompany ?? [];
  const noMatch = data?.noMatchPeople ?? [];
  const nothing = !isLoading && data && data.friends === 0;

  return (
    <div className="space-y-8">
      <PageHeader
        backHref="/?tab=uploaders"
        backLabel="Relationship owners"
        title={name}
        description="The friends this person owns the relationship with, and how many their network reaches."
      />

      {isLoading ? (
        <UploaderSkeleton />
      ) : nothing ? (
        <EmptyState
          icon={UserX}
          title="No friends on file for this relationship owner"
          description="Their roster may have been removed, or the name may be spelled differently."
          action={
            <Link href="/?tab=uploaders" className="text-sm font-medium text-primary hover:underline">
              Back to relationship owners
            </Link>
          }
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile label="Friends" value={compactCount(data?.friends ?? 0)} hint="on this owner's list" />
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
              description="Friends with no connection on file yet — the names still to place, each with the closest contact a run turned down for them."
            />
            {noMatch.length === 0 ? (
              <EmptyState
                icon={UserCheck}
                title="Everyone's connected"
                description="Every friend this person uploaded reaches someone on file."
              />
            ) : (
              <div className="flex flex-wrap gap-2 rounded-lg border p-4">
                {noMatch.map((p) => (
                  <NoMatchBadge key={p.friend} person={p} />
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
 *  the uploaded friend name beneath it, and how close the match was on the right. Falls back to the
 *  uploaded name when the contact has no English spelling on file. */
function MatchedRow({ person }: { person: MatchedPerson }) {
  const primary = person.en || person.friend;
  const score = formatSimilarity(person.similarity);
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

      {/*
        How close the two names were. This list is every pairing a run called a match, and until now
        it read as one flat claim — "these are the same person" — for both an exact name and a near
        miss. The percent is the difference between an introduction you can ask for and one worth
        checking first.

        Rendered only when a run recorded one: a matcher that reports verdicts alone leaves nothing
        to say here, and "—" in a list (unlike in a table column) is furniture, not information.
      */}
      {score && (
        <span
          title="How close the two names were"
          className="mt-0.5 shrink-0 text-sm tabular-nums text-muted-foreground"
        >
          {score}
        </span>
      )}
    </div>
  );
}

/**
 * One unplaced friend, and the nearest thing to them on file.
 *
 * This was the name alone, and the name alone is a dead end: "amporn chukfat has no connection" is
 * true and leaves you nothing to do with it. The matcher did not give up in silence — it scored her
 * against every contact in scope and kept the closest one, with that contact's Thai name, employer
 * and score sitting unread on the result row. Shown here, the entry becomes checkable: a 78% near
 * miss at a company you recognise is a name to look at by hand, and a 22% one is the list working
 * correctly.
 *
 * The Thai name and the company are the CONTACT's, never the friend's — a friend list carries one
 * name and no employer, so there is nothing else they could be. That is why the friend's name is
 * full-strength and the rest is dimmed behind a dot: two facts of different kinds, in the order
 * "who you uploaded", "who we nearly matched them to". The percent is what stops the pairing being
 * read as a match; it is always below whatever bar the matcher applied, or this badge would be a
 * row in the Matched list instead. The tooltip says all of that in words, because a dimmed company
 * name beside a person is exactly the shape of a claim we are not making.
 *
 * A friend no run has scored keeps the bare badge this list used to be — nothing was rejected for
 * them, and inventing an em dash where a candidate would go would describe the matcher's silence as
 * a finding about the friend.
 */
function NoMatchBadge({ person }: { person: NoMatchPerson }) {
  // Thai first, English second: the matched list leads with English because that is the actionable
  // identity, but here the pairing is being *checked* rather than acted on, and the Thai spelling is
  // the one that settles whether the matcher was close.
  const contact = person.th || person.en;
  const score = formatSimilarity(person.similarity);
  const detail = [contact, person.company].filter(Boolean).join(" · ");
  const title = detail
    ? `Closest contact considered — ${contact ?? "an unnamed contact"}${
        person.company ? ` at ${person.company}` : ""
      }${score ? `, a ${score} name match` : ""}. Not close enough to call a connection.`
    : "No run has scored this friend against anyone on file yet.";

  return (
    // `max-w-full` + a truncating detail so one long company name cannot push the cloud wider than
    // the page. The friend's name is never the part that gives way — it is why the entry is here.
    <Badge variant="outline" title={title} className="max-w-full text-muted-foreground">
      <span className="text-foreground">{person.friend}</span>
      {detail && <span className="min-w-0 truncate opacity-75">· {detail}</span>}
      {score && <span className="tabular-nums opacity-60">· {score}</span>}
    </Badge>
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
