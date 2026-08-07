"use client";

import * as React from "react";
import { UserCheck, UserSearch, UserX } from "lucide-react";
import {
  compareByAxes,
  hasThai,
  LANGUAGE_LABEL,
  matchReason,
  parseCompareBy,
  scoreQualifier,
  type NoMatchPerson,
} from "@extensions/contract";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { PAGE_SIZE, Pager } from "@/components/pagination";
import { SectionHeader } from "@/components/page-header";
import { MarkedName } from "@/components/marked-name";
import { Score } from "@/components/score";
import { GroupHeader } from "@/components/network/uploader/GroupHeader";
import { recordedLanguage, thaiLang, wasScored } from "@/components/network/uploader/roster";
import { formatSimilarity } from "@/lib/format";

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
 *
 * The search is the PAGE's, not this section's — it reached only this list while the question people
 * were asking it ("was this friend placed?") is answered by which of the two sections a name appears
 * in. `people` is still the whole list, because the counts in the headings state what a search is
 * hiding and cannot be recovered from `shown`.
 */
export function NoMatchSection({
  people,
  shown,
  query,
  onClearSearch,
}: {
  /** The whole unplaced list — what the counts are stated against. */
  people: NoMatchPerson[];
  /** The subset the page's search left, already filtered against the friend's name AND their near
   *  miss (see `hitsNoMatch`). Equal to `people` when nothing is being searched for. */
  shown: NoMatchPerson[];
  /** The raw search text, or "" — for wording the empty state and the "3 of 12". Quoted back as
   *  TYPED: the filter folds case, the sentence reporting it must not. */
  query: string;
  onClearSearch: () => void;
}) {
  const needle = query.trim();

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

  // The page's search, applied to each half. Identity-matched against the already-filtered array
  // rather than re-running the predicate, so the two lists and the "N matched · M unmatched" line
  // above them cannot disagree about what the search found.
  const keep = React.useMemo(() => new Set(shown), [shown]);
  const shownScored = needle ? scored.filter((p) => keep.has(p)) : scored;
  const shownUnscored = needle ? unscored.filter((p) => keep.has(p)) : unscored;
  const empty = shownScored.length === 0 && shownUnscored.length === 0;

  /**
   * A page each, because these are two lists and not one.
   *
   * They are usually short — a roster that has been run holds a dozen or two unplaced friends, and
   * both pagers stay invisible at that size (`Pager` renders nothing under two pages). They exist
   * for the case this section was built against and still meets: a roster nothing has ever scored,
   * where "Not yet scored" is every friend on file and the list is the length of the import.
   */
  const [scoredPage, setScoredPage] = React.useState(1);
  const [unscoredPage, setUnscoredPage] = React.useState(1);
  React.useEffect(() => {
    setScoredPage(1);
    setUnscoredPage(1);
  }, [query]);

  const scoredPages = Math.ceil(shownScored.length / PAGE_SIZE);
  const unscoredPages = Math.ceil(shownUnscored.length / PAGE_SIZE);
  // Clamped for the same reason the matched half is: the bar above moves friends between these two
  // lists, so either can shrink under a page that is already open.
  const scoredAt = Math.min(scoredPage, Math.max(1, scoredPages));
  const unscoredAt = Math.min(unscoredPage, Math.max(1, unscoredPages));
  const scoredRows = shownScored.slice((scoredAt - 1) * PAGE_SIZE, scoredAt * PAGE_SIZE);
  const unscoredRows = shownUnscored.slice((unscoredAt - 1) * PAGE_SIZE, unscoredAt * PAGE_SIZE);

  return (
    <section id="no-match" className="space-y-4 scroll-mt-6">
      <SectionHeader title="No match" description={describeNoMatch(scored.length, unscored.length)} />

      {empty ? (
        <EmptyState
          icon={UserSearch}
          title={`No unmatched friend matches “${needle}”`}
          description="Try a shorter spelling — every friend here is one this owner uploaded and no run has placed."
          action={
            <Button variant="outline" size="sm" onClick={onClearSearch}>
              Clear search
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {shownScored.length > 0 && (
            <div className="space-y-3">
              <div className="overflow-hidden rounded-lg border">
                <GroupHeader
                  icon={UserSearch}
                  title="Considered and turned down"
                  detail={`${counted(shownScored.length, scored.length, needle)} · closest first`}
                  tooltip="A run scored each of these against the closest contact on file and decided against it. The score is how close that came."
                />
                {/* Keyed on the position in the WHOLE list, not in the page — `${friend}-${i}`
                    restarting at 0 on every page makes page 2's first row share a key with page
                    1's, and React reuses the DOM node for a different person. */}
                {scoredRows.map((p, i) => (
                  <NearMissRow key={`${p.friend}-${(scoredAt - 1) * PAGE_SIZE + i}`} person={p} />
                ))}
              </div>
              <Pager
                page={scoredAt}
                totalPages={scoredPages}
                onPageChange={setScoredPage}
                label="near misses"
              />
            </div>
          )}

          {shownUnscored.length > 0 && (
            <div className="space-y-3">
              <div className="overflow-hidden rounded-lg border">
                <GroupHeader
                  icon={UserX}
                  title="Not yet scored"
                  detail={`${counted(shownUnscored.length, unscored.length, needle)} · never compared`}
                  tooltip="No comparison has scored these friends against anybody yet, so there is no near miss to show — only the name. Run a comparison to place them."
                />
                {/* Columns, not a wrapping cloud: fifty names in four columns is thirteen lines you
                    can run an eye down alphabetically, where the same fifty as chips is a paragraph
                    whose line breaks fall wherever the names happen to end. */}
                <ul className="grid gap-x-6 gap-y-1.5 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {unscoredRows.map((p, i) => (
                    <li
                      key={`${p.friend}-${(unscoredAt - 1) * PAGE_SIZE + i}`}
                      lang={thaiLang(p.friend)}
                      className="truncate"
                      title={p.friend}
                    >
                      {p.friend}
                    </li>
                  ))}
                </ul>
              </div>
              <Pager
                page={unscoredAt}
                totalPages={unscoredPages}
                onPageChange={setUnscoredPage}
                label="friends never compared"
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Everyone reached somebody — the section replaced by its own good news. */
export function EveryoneConnected() {
  return (
    <section id="no-match" className="space-y-4 scroll-mt-6">
      <SectionHeader title="No match" />
      <EmptyState
        icon={UserCheck}
        title="Everyone's connected"
        description="Every friend this person uploaded reaches someone on file."
      />
    </section>
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

/**
 * One unplaced friend, and the nearest thing to them on file.
 *
 * The name alone is a dead end: "amporn chukfat has no connection" is true and leaves you nothing to
 * do with it. The matcher did not give up in silence — it scored her against every contact in scope
 * and kept the closest one, with that contact's names, employer and score sitting unread on the
 * result row. Shown here the entry becomes checkable: a 78% near miss at a company you recognise is
 * a name to look at by hand, and a 22% one is the list working correctly.
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
  const mode = parseCompareBy(person.mode);
  const { type } = compareByAxes(mode);
  /**
   * WHICH SPELLING THE RUN HELD AGAINST THEM — read the same way a matched row reads it, off the
   * script of the friend name rather than off the column the contact name happens to sit in. The
   * external workflow writes whichever spelling it scored into `person_name_en`, so trusting the
   * column pairs a Latin friend with a Thai candidate and prints a percentage between them.
   *
   * Weaker evidence than on the matched side, and worth being honest about: `NoMatchPerson.friend`
   * comes from the friend record rather than from the result row, so it is the spelling we hold
   * today and not provably the one that was scored. It is still the only signal there is, and it is
   * right whenever the roster holds one name — which is the ordinary case.
   */
  const language = recordedLanguage(person.friend, person.mode);
  const thai = language === "th";
  const clean = (s: string | null) => s?.trim() || null;
  const scored = clean(thai ? person.th : person.en);
  const otherOnRow = clean(thai ? person.en : person.th);
  const contact = scored ?? otherOnRow;
  const contactAlt =
    contact && otherOnRow && otherOnRow !== contact && hasThai(otherOnRow) !== thai
      ? otherOnRow
      : null;

  const score = formatSimilarity(person.similarity);
  // What the near miss actually measured. Without it "closest was somchai jaidee at 61%" reads as a
  // weak resemblance between two whole names, when under `en_surname` it means two SURNAMES scored
  // 61% and the given names were never looked at — a different and much less interesting fact.
  const qualifier = scoreQualifier(mode);
  const unit =
    language === compareByAxes(mode).language ? `${qualifier} · ${LANGUAGE_LABEL[language]}` : null;
  const title = `Closest contact considered — ${contact ?? "an unnamed contact"}${
    person.company ? ` at ${person.company}` : ""
  }${score ? `, a ${score} ${qualifier} match` : ""}. Not close enough to call a connection.`;

  return (
    <div className="flex items-start gap-3 border-b p-4 transition-colors last:border-b-0 hover:bg-muted/40">
      {/* Muted, never amber. Amber is a lead in this app — something to act on — and this row is
          the opposite claim: the matcher looked and said no. */}
      <UserSearch className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />

      <div className="min-w-0 flex-1 space-y-0.5">
        <p lang={thaiLang(person.friend)} className="truncate font-medium">
          {person.friend}
        </p>
        {/* Everything here is the CONTACT's — a friend list carries one name and no employer, so
            there is nothing else it could be. "Closest" rather than the matched rows' arrow: this
            is deliberately NOT rendered as a pairing, because a pairing is the claim the section
            exists to say we are not making. */}
        <div
          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm text-muted-foreground"
          title={title}
        >
          <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            Closest:{" "}
            {contact ? (
              <MarkedName name={contact} type={type} lang={scored && thai ? "th" : undefined} />
            ) : (
              "an unnamed contact"
            )}
            {contactAlt && (
              <span
                lang={thai ? undefined : "th"}
                title={`Also on file as ${contactAlt}. This spelling was not the one scored.`}
              >
                ({contactAlt})
              </span>
            )}
          </span>
          {person.company && <span className="truncate">at {person.company}</span>}
        </div>
      </div>

      {/*
        How close the two names got, through the SAME chip a matched row and a company page use — so
        a percentage's hue means one thing everywhere: how close, and nothing about the verdict. The
        verdict is the section this row is in.

        Dropped entirely when no run recorded a score, because an absent measurement is not a low
        one — hence the guard rather than letting `Score` render its dash, which is a table's answer
        and not a list's.
      */}
      {score && (
        <span title={matchReason(mode, score)} className="mt-0.5 shrink-0">
          <Score value={person.similarity} qualifier={unit} />
        </span>
      )}
    </div>
  );
}
