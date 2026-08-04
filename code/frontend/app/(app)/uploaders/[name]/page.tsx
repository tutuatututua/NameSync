"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Building2, Search, UserCheck, UserSearch, UserX } from "lucide-react";
import {
  matchReason,
  matchStrength,
  scoreQualifier,
  type CompanyMatchGroup,
  type MatchedPerson,
  type NoMatchPerson,
} from "@extensions/contract";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatTile, compactCount } from "@/components/stat-tile";
import { MatchedHint } from "@/components/network/match-grade";
import { formatSimilarity } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useNetworkUploader } from "@/hooks/queries";
import { readThreshold, withThreshold } from "@/hooks/useThreshold";

/**
 * One relationship owner — every friend they contributed, split into the names their network placed
 * and the names it hasn't.
 *
 * This is the drill-down behind the Relationship owners tab and behind every "known by / reached
 * by" chip in the app: the counts were always visible, but the *names* were not, and the names are
 * the point —
 * "which of my friends still has no connection" is the list you act on. Matched friends carry the
 * company they landed at (a link straight to it); unmatched friends carry whatever a run recorded
 * while turning them down, and are split by whether one ever did — see `NoMatchSection`.
 */
export default function UploaderPage() {
  const params = useParams<{ name: string }>();
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
  const { data, isLoading } = useNetworkUploader(name, threshold ?? undefined);

  const matched = data?.matchedByCompany ?? [];
  const noMatch = data?.noMatchPeople ?? [];
  const nothing = !isLoading && data && data.friends === 0;
  const importedBy = data?.importedBy ?? [];

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
              <span className="mt-1 block text-sm">
                Imported by {importedBy.join(", ")}
              </span>
            )}
          </>
        }
      />

      {isLoading ? (
        <UploaderSkeleton />
      ) : nothing ? (
        <EmptyState
          icon={UserX}
          title="No friends on file for this relationship owner"
          /* The third reason is new, and it is the one that actually fired: this page is keyed on
             whose relationship a friend is, and a name that only ever performed IMPORTS owns
             nothing. Worth naming rather than leaving the reader to conclude their data is gone —
             "removed or misspelled" is alarming, and both were wrong. */
          description="Their roster may have been removed, the name may be spelled differently, or this person imported friends for somebody else and owns no relationships of their own."
          action={
            <Link href={withThreshold("/?tab=uploaders", threshold)} className="text-sm font-medium text-primary hover:underline">
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
              hint={
                <MatchedHint
                  matched={data?.matched ?? 0}
                  confirmed={data?.confirmed ?? 0}
                  fallback="friends with a connection"
                />
              }
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
                  <CompanyGroup key={group.company} group={group} threshold={threshold} />
                ))}
              </div>
            )}
          </div>

          {noMatch.length === 0 ? (
            <div className="space-y-4">
              <SectionHeader title="No match" />
              <EmptyState
                icon={UserCheck}
                title="Everyone's connected"
                description="Every friend this person uploaded reaches someone on file."
              />
            </div>
          ) : (
            <NoMatchSection people={noMatch} />
          )}
        </>
      )}
    </div>
  );
}

/** One company section: a header linking to the company page, then its matched people. */
function CompanyGroup({ group, threshold }: { group: CompanyMatchGroup; threshold: number | null }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <Link
        href={withThreshold(`/companies/${encodeURIComponent(group.company)}`, threshold)}
        className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2.5 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60"
      >
        <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{group.company}</span>
        {/* The split rides on the header rather than on a separate section, because the rows below
            are sorted confirmed-first and the header is what tells you where the line falls. */}
        <span className="shrink-0 text-sm text-muted-foreground">
          {group.people.length} {group.people.length === 1 ? "person" : "people"}
          {group.people.length > group.confirmed && (
            <span className="text-confidence-medium">
              {" "}
              · {group.people.length - group.confirmed} lead
              {group.people.length - group.confirmed === 1 ? "" : "s"}
            </span>
          )}
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
  const confirmed = matchStrength(person.mode) === "confirmed";
  const qualifier = scoreQualifier(person.mode);
  const Icon = confirmed ? UserCheck : UserSearch;

  return (
    <div className="flex items-start gap-3 border-b p-4 transition-colors last:border-b-0 hover:bg-muted/40">
      {/* The row's own grade, in the gutter where the eye already lands. Amber + a search glyph for
          a lead: this row is a question, not a placement. */}
      <div
        className={cn(
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border",
          confirmed
            ? "border-confidence-high/25 bg-confidence-high/10 text-confidence-high"
            : "border-confidence-medium/25 bg-confidence-medium/10 text-confidence-medium"
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate font-medium">{primary}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
          {/* `lang` here and not inside the badges: `:lang(th)`'s taller line-height is fine on a
              row line, where the leading is already generous, but would make a Thai chip taller
              than the Latin chip beside it. */}
          {person.th && (
            <span lang="th" className="truncate">
              {person.th}
            </span>
          )}
          {/* The uploaded friend name — how they appear in this person's own contact list. */}
          <span className="truncate">Uploaded as “{person.friend}”</span>
        </div>
      </div>

      {/*
        How close the two names were, AND what "close" measured. This list is every pairing a run
        called a match, and it used to read as one flat claim — "these are the same person" — for
        both an exact whole name and a shared surname. The percent alone did not fix that: 94% reads
        the same either way. The qualifier is the number's unit, so `surname 94%` and `full name 94%`
        stop being the same sentence.

        ON EVERY MODE, including `full`. The unit used to be omitted there, on the reasoning that a
        bare percent already means the whole name — but this list interleaves runs of every mode, so
        the unlabelled number was the one claim nobody could identify at a glance. See
        `scoreQualifier`.

        Rendered only when a run recorded one: a matcher that reports verdicts alone leaves nothing
        to say here, and "—" in a list (unlike in a table column) is furniture, not information. The
        qualifier goes with it — an unqualified absence is not a claim about anything.
      */}
      {score && (
        <span
          title={matchReason(person.mode, score)}
          className={cn(
            "mt-0.5 shrink-0 text-sm tabular-nums",
            confirmed ? "text-muted-foreground" : "text-confidence-medium"
          )}
        >
          {qualifier} {score}
        </span>
      )}
    </div>
  );
}

/** Did any run ever score this friend against anybody? All four near-miss fields are null when
 *  none did — see `NoMatchPerson`. Any one of them present means a run looked and said no. */
const wasScored = (p: NoMatchPerson): boolean =>
  Boolean(p.en || p.th || p.company) || p.similarity !== null;

/** How long the list has to get before finding one name in it stops being possible by eye. */
const FILTER_AT = 12;

/**
 * The unplaced half of a roster.
 *
 * This was one flat cloud of badges over every unmatched friend, alphabetical, and it collapsed two
 * different facts into one shape. "amporn chukfat, closest was somchai jaidee at 78% at BANGKOK
 * BANK" is a name to check by hand. "amporn chukfat" with nothing after it is not a weaker version
 * of that — it means no run has ever scored her, and the thing to fix is the *runs*, not her. Both
 * rendered as the same chip, so the second read as the first with fields missing, and a roster like
 * the one this page was built against — fifty friends, not one of them ever compared — read as fifty
 * near misses too faint to print.
 *
 * So they are two lists. Scored friends first, as rows, closest near miss at the top, because that
 * order is the to-do list: the 78% is worth an afternoon and the 22% is the matcher working. Then
 * the never-scored, as a plain alphabetical grid, because a bare name is all there is to say and
 * fifty bare names want columns rather than a ragged wrap. The heading over each states which claim
 * it is making, and the section's own description states what is actually below it rather than
 * promising a near miss the data may not contain.
 *
 * Sorting by closeness is NOT re-judging the matcher — no cutoff appears anywhere here, and nothing
 * in this section is grouped, tinted or promoted by score. `similarity` is "for sorting and display,
 * never the verdict" (`row-status.ts`), and a rank is the one use of it that adds no claim: every
 * friend below is unmatched, and stays unmatched, whatever they scored.
 */
function NoMatchSection({ people }: { people: NoMatchPerson[] }) {
  const [filter, setFilter] = React.useState("");

  const [scored, unscored] = React.useMemo(() => {
    const yes: NoMatchPerson[] = [];
    const no: NoMatchPerson[] = [];
    for (const p of people) (wasScored(p) ? yes : no).push(p);
    // Closest first, then alphabetical. A named candidate a run recorded no score for sorts below
    // every scored one (`-1`) rather than above them — it is the weakest evidence here, not the best.
    yes.sort((a, b) => (b.similarity ?? -1) - (a.similarity ?? -1) || a.friend.localeCompare(b.friend));
    // `no` keeps the server's roster order, which is already alphabetical — and alphabetical is the
    // only honest order for it. There is nothing to rank these by; that is what makes them this list.
    return [yes, no];
  }, [people]);

  // Filters the friend's name AND the near miss, so "BANGKOK BANK" finds everyone the matcher put
  // near that company — the reason you would reach for the box on a scored list at all.
  const needle = filter.trim().toLowerCase();
  const hit = (p: NoMatchPerson) =>
    !needle ||
    [p.friend, p.en, p.th, p.company].some((v) => v?.toLowerCase().includes(needle));
  const shownScored = needle ? scored.filter(hit) : scored;
  const shownUnscored = needle ? unscored.filter(hit) : unscored;
  const empty = shownScored.length === 0 && shownUnscored.length === 0;

  return (
    <div className="space-y-4">
      <SectionHeader
        title="No match"
        description={describeNoMatch(scored.length, unscored.length)}
        actions={
          people.length > FILTER_AT && (
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter these names…"
                className="h-9 pl-9"
                aria-label="Filter friends with no match"
              />
            </div>
          )
        }
      />

      {empty ? (
        <EmptyState
          icon={UserSearch}
          title={`No unmatched friend matches “${filter.trim()}”`}
          description="Try a shorter spelling, or clear the filter to see the whole list."
        />
      ) : (
        <div className="space-y-4">
          {shownScored.length > 0 && (
            <div className="overflow-hidden rounded-lg border">
              <GroupHeader
                icon={UserSearch}
                title="Considered and turned down"
                detail={`${counted(shownScored.length, scored.length, needle)} · closest first`}
              />
              {shownScored.map((p, i) => (
                <NearMissRow key={`${p.friend}-${i}`} person={p} />
              ))}
            </div>
          )}

          {shownUnscored.length > 0 && (
            <div className="overflow-hidden rounded-lg border">
              <GroupHeader
                icon={UserX}
                title="Not yet scored"
                detail={`${counted(shownUnscored.length, unscored.length, needle)} · no run has compared them against anyone`}
              />
              {/* Columns, not a wrapping cloud: fifty names in four columns is thirteen lines you
                  can run an eye down alphabetically, where the same fifty as chips is a paragraph
                  whose line breaks fall wherever the names happen to end. */}
              <ul className="grid gap-x-6 gap-y-1.5 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {shownUnscored.map((p, i) => (
                  <li key={`${p.friend}-${i}`} className="truncate" title={p.friend}>
                    {p.friend}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What the section says it contains — worded from what is actually in it.
 *
 * The old description promised "each with the closest contact a run turned down for them"
 * unconditionally, and on a roster nothing has scored it printed that sentence over fifty bare
 * names. A reader can only conclude the near misses failed to load. The absence is not a rendering
 * gap, it is the finding, so each mix gets its own sentence and the all-unscored case says what to
 * do about it.
 */
function describeNoMatch(scored: number, unscored: number): string {
  const lead = "Friends with no connection on file yet";
  if (scored === 0)
    return `${lead}. No run has scored any of them against anyone, so there is nothing to show but the names — run a comparison to place them.`;
  if (unscored === 0)
    return `${lead} — each with the closest contact a run considered and turned down.`;
  return `${lead}. The ones a run scored come first, closest near miss at the top; the rest have never been compared.`;
}

/** `12 friends`, or `3 of 12 friends` once a filter is hiding some of them. */
function counted(shown: number, total: number, needle: string): string {
  const noun = total === 1 ? "friend" : "friends";
  return needle && shown !== total ? `${shown} of ${total} ${noun}` : `${total} ${noun}`;
}

/** The bar over one of the two lists — the same shape as a company group's header, minus the link,
 *  because these headings name a claim rather than somewhere to go. */
function GroupHeader({
  icon: Icon,
  title,
  detail,
}: {
  icon: typeof UserSearch;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
      <span className="shrink-0 text-sm text-muted-foreground">{detail}</span>
    </div>
  );
}

/**
 * One unplaced friend, and the nearest thing to them on file.
 *
 * The name alone is a dead end: "amporn chukfat has no connection" is true and leaves you nothing to
 * do with it. The matcher did not give up in silence — it scored her against every contact in scope
 * and kept the closest one, with that contact's names, employer and score sitting unread on the
 * result row. Shown here the entry becomes checkable: a 78% near miss at a company you recognise is
 * a name to look at by hand, and a 22% one is the list working correctly.
 *
 * A row rather than the badge this used to be. The badge had to spend its width on the friend's name
 * and then truncate the near miss — the half that makes the entry checkable — and it could not put
 * the scores in a column, which is the one layout that lets fifty of them be compared at a glance.
 *
 * Everything after the friend's name is the CONTACT's — a friend list carries one name and no
 * employer, so there is nothing else it could be. Hence the friend at full strength on its own line
 * and the candidate dimmed beneath it, labelled "Closest": two facts of different kinds, in the
 * order "who you uploaded", "who we nearly matched them to". The gutter icon is deliberately muted
 * rather than amber — amber is a lead in this app, something to act on, and this row is the opposite
 * claim. The tooltip says all of it in words, because a company name beside a person is exactly the
 * shape of a claim we are not making.
 */
function NearMissRow({ person }: { person: NoMatchPerson }) {
  // Thai first: the matched list leads with English because that is the actionable identity, but
  // here the pairing is being *checked* rather than acted on, and the Thai spelling is usually the
  // one that settles whether the matcher was close. Both when both exist — the row has the width the
  // badge did not, and dropping a spelling the reader might recognise to save it is a bad trade.
  const names = [person.th, person.en].filter(Boolean) as string[];
  const contact = names[0];
  const score = formatSimilarity(person.similarity);
  // What the near miss actually measured. Without it "closest was somchai jaidee at 61%" reads as a
  // weak resemblance between two whole names, when under `en_surname` it means two SURNAMES scored
  // 61% and the given names were never looked at — a different and much less interesting fact.
  const qualifier = scoreQualifier(person.mode);
  const title = `Closest contact considered — ${contact ?? "an unnamed contact"}${
    person.company ? ` at ${person.company}` : ""
  }${score ? `, a ${score} ${qualifier} match` : ""}. Not close enough to call a connection.`;

  return (
    <div className="flex items-start gap-3 border-b p-4 transition-colors last:border-b-0 hover:bg-muted/40">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
        <UserSearch className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate font-medium">{person.friend}</p>
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground"
          title={title}
        >
          <span className="truncate">
            Closest:{" "}
            {/* `lang` on the Thai spelling only, and only when it is the one on file: `:lang(th)`'s
                taller line-height is fine on a row line, and wrong on the Latin span beside it. */}
            {person.th && <span lang="th">{person.th}</span>}
            {person.th && person.en && " · "}
            {person.en}
            {names.length === 0 && "an unnamed contact"}
          </span>
          {person.company && <span className="truncate">at {person.company}</span>}
        </div>
      </div>

      {/*
        How close the two names got, AND what "close" measured — the same pairing the matched rows
        make, for the same reason: `surname 61%` and `full name 61%` are not the same sentence.
        Muted, never amber: the number is why this row is worth your attention among the others here,
        not evidence of a connection. Dropped entirely when no run recorded one, because an absent
        score is not a low one.
      */}
      {score && (
        <span
          title={matchReason(person.mode, score)}
          className="mt-0.5 shrink-0 text-sm tabular-nums text-muted-foreground"
        >
          {qualifier} {score}
        </span>
      )}
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
