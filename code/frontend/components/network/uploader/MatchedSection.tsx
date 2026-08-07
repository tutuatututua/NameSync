"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Building2, UserCheck, UserSearch } from "lucide-react";
import {
  compareByAxes,
  compareByLabel,
  LANGUAGE_LABEL,
  matchReason,
  parseCompareBy,
  scoreQualifier,
  type CompanyMatchGroup,
  type MatchedPerson,
} from "@extensions/contract";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { PAGE_SIZE, Pager } from "@/components/pagination";
import { SectionHeader } from "@/components/page-header";
import { MarkedName } from "@/components/marked-name";
import { Side } from "@/components/pair-side";
import { Score } from "@/components/score";
import { GroupHeader } from "@/components/network/uploader/GroupHeader";
import {
  distinctFriends,
  readPairing,
  runLabel,
  toPairings,
  type Pairing,
  type ScoredPairing,
} from "@/components/network/uploader/roster";
import { formatSimilarity } from "@/lib/format";
import { useCarriedThreshold, withThreshold } from "@/hooks/useThreshold";
import { cn } from "@/lib/utils";

/**
 * The placed half of a roster — every friend who reaches somebody, grouped by where they reach.
 *
 * ── ONE ROW PER CONNECTION, NOT PER FRIEND (2026-08-06) ──
 *
 * This list used to render its first row for a friend in full and every later one as an indented
 * "Also found by <run>", on the premise that a repeat is the same claim found again and the person
 * is already named on the line above. The premise held for the case it was designed against — an
 * English run and a Thai run agreeing about one pairing — and was false about most of the data:
 * a friend commonly matches SEVERAL DIFFERENT PEOPLE at one company, and every one of them after
 * the first was collapsed into a footnote under somebody else's name. `arnat rojanapruk` reaches
 * both `arunee rojanapruk` and `arnat wongsawat` at BANGKOK BANK; the page showed one name and
 * called the other "also found by File · 4".
 *
 * A row is now a PAIRING (see `toPairings`), so the name on it is always the person you would ask
 * for, and "also found by" appears only where it is true — the same two people, found again by a
 * comparison asking a different question.
 *
 * ── IT IS PAGED, AND THE PAGE IS CUT IN ROWS (2026-08-07) ──
 *
 * This section rendered the whole matched half in one go, and on this database that is around 220
 * connections spread over 15 companies for a single owner — a page you scroll for a minute with no
 * way to say "the second half". The rest of the app had been paged at twenty for a while; the one
 * screen holding the most rows was the one still holding all of them.
 *
 * The unit is the CONNECTION ROW, not the company group, and that is the whole decision here. Paging
 * by group would have been a line of code — but every owner on this database matches into exactly 15
 * companies, so a page of twenty groups is one page, and the section would be just as long as it was
 * while claiming to be paged. Twenty rows is twenty rows whatever shape the groups are.
 *
 * A company therefore SPLITS across pages when it is bigger than what is left of one, and its header
 * says so ("5 of 23 here"). The header's own counts stay the whole company's, because they are facts
 * about the company that the tiles at the top of the page are also counted in — a header that
 * re-counted itself per page would report a different number of friends at BANGKOK BANK depending on
 * where the page boundary fell.
 */
export function MatchedSection({
  groups,
  shown,
  query,
  threshold,
  ungrouped,
  onClearSearch,
}: {
  /** Every company group on the roster — what the empty states are decided against. */
  groups: CompanyMatchGroup[];
  /** The subset the page's search left. Equal to `groups` when nothing is searched for. */
  shown: CompanyMatchGroup[];
  /** The raw search text, for wording an empty state. Note it is NOT the lower-cased needle: a
   *  reader who typed "Bangkok" must see "Bangkok" quoted back, not "bangkok". */
  query: string;
  threshold: number | null;
  /**
   * Matched friends with nowhere to appear below — their run recorded no company.
   *
   * The Matched tile counts them (a connection is a connection) and this list cannot show them, so
   * without a line saying so the two disagree by a number the reader can see and not explain. The
   * server has always allowed it; the page never mentioned it.
   */
  ungrouped: number;
  onClearSearch: () => void;
}) {
  const [page, setPage] = React.useState(1);
  const sectionRef = React.useRef<HTMLElement>(null);
  // A new search is a new list, and page 4 of the old one is nowhere in it — the same re-page every
  // searchable list in the app does. On `query` (the raw box) rather than on `shown`, which is a
  // fresh array on every render of the page above and would reset this to 1 on every keystroke
  // anywhere on it.
  React.useEffect(() => setPage(1), [query]);

  /**
   * Turning a page puts you back at the TOP of the section, and this is the one list in the app
   * where that is worth doing.
   *
   * Twenty connection rows here are grouped, carry evidence lines and run to well over a screen, so
   * the pager sits a long way below the first row. Pressing "next" without this leaves the reader
   * parked at the bottom of the new page, looking at rows 17–20 of it, with the first sixteen
   * scrolled past above them — which reads as the list having jumped rather than turned.
   *
   * `block: "start"` against the section's own `scroll-mt-6`, so it lands where the anchor links
   * from the tiles land. Instant rather than smooth where the reader has asked for less motion.
   */
  const turn = (next: number) => {
    setPage(next);
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    sectionRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  };

  /**
   * Every connection in the section, flattened, each still carrying the company it belongs to and
   * that company's full set of pairings.
   *
   * Flattened HERE rather than inside each `CompanySection` because the page boundary is cut across
   * groups: a component that folds its own rows cannot know that it is the group the boundary falls
   * in. The company keeps its identity through the flatten (`group` is the same object reference all
   * the way down), which is what lets the slice be re-grouped below without matching on names.
   */
  const items = React.useMemo(() => {
    const out: { group: CompanyMatchGroup; pairings: Pairing[]; pairing: Pairing }[] = [];
    for (const group of shown) {
      const pairings = toPairings(group.people);
      for (const pairing of pairings) out.push({ group, pairings, pairing });
    }
    return out;
  }, [shown]);

  const totalPages = Math.ceil(items.length / PAGE_SIZE);
  // Clamped, not trusted: the roster re-reads at a new threshold under a page that is already open,
  // and a bar that drops a hundred connections can leave `page` past the end of the list.
  const current = Math.min(page, Math.max(1, totalPages));

  /**
   * This page's rows, folded back into the companies they came from.
   *
   * Consecutive runs only — the flatten preserved the server's order, so one company's rows are
   * adjacent by construction and a company cannot appear twice on one page.
   */
  const blocks = React.useMemo(() => {
    const slice = items.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
    const out: { group: CompanyMatchGroup; pairings: Pairing[]; rows: Pairing[] }[] = [];
    for (const item of slice) {
      const last = out[out.length - 1];
      if (last && last.group === item.group) last.rows.push(item.pairing);
      else out.push({ group: item.group, pairings: item.pairings, rows: [item.pairing] });
    }
    return out;
  }, [items, current]);

  return (
    <section id="matched" ref={sectionRef} className="space-y-4 scroll-mt-6">
      <SectionHeader
        title="Matched"
        description="Friends who connect to someone on file, grouped by the company they reach."
      />

      {ungrouped > 0 && (
        <p className="text-sm text-muted-foreground">
          {ungrouped === 1
            ? "One more friend has a connection that recorded no company, so there is no section for them below."
            : `${ungrouped.toLocaleString()} more friends have a connection that recorded no company, so there is no section for them below.`}
        </p>
      )}

      {groups.length === 0 ? (
        <EmptyState
          icon={UserCheck}
          title="No matches yet"
          description="None of this person's friends has turned up at a company on file."
        />
      ) : shown.length === 0 ? (
        /* A finding about the SEARCH, not about the roster — this owner does have matches, none of
           them spelled like this. Worded so it cannot be read as "nobody matched". */
        <EmptyState
          icon={UserSearch}
          title={`No matched friend or company matches “${query.trim()}”`}
          description="They may be in the no-match list below, or spelled differently."
          action={
            <Button variant="outline" size="sm" onClick={onClearSearch}>
              Clear search
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {blocks.map((block) => (
            <CompanySection
              key={block.group.company}
              group={block.group}
              pairings={block.pairings}
              rows={block.rows}
              threshold={threshold}
            />
          ))}

          {/* Counted in CONNECTIONS, because that is what the pages are cut in. The friend count is
              the tile at the top of the page and the per-company headers above — stating it a third
              time here, against a different denominator, is how three numbers about one roster end
              up disagreeing. */}
          <Pager
            page={current}
            totalPages={totalPages}
            onPageChange={turn}
            label="matched connections"
            summary={`Page ${current.toLocaleString()} of ${totalPages.toLocaleString()} · ${items.length.toLocaleString()} connection${
              items.length === 1 ? "" : "s"
            }`}
          />
        </div>
      )}
    </section>
  );
}

/**
 * One company: a header linking to its page, then this page's connections into it.
 *
 * It no longer folds its own rows. `MatchedSection` does that, because the page boundary is cut
 * across companies and a component that could only see its own group would have no way to know it is
 * the one being split — see that file's header. What arrives here is the company (for its header
 * counts), its FULL set of pairings (for the same reason) and the subset this page shows.
 */
function CompanySection({
  group,
  pairings,
  rows,
  threshold,
}: {
  group: CompanyMatchGroup;
  /** Every connection into this company, whatever this page is showing — what the header counts. */
  pairings: Pairing[];
  /** The ones on this page. Shorter than `pairings` exactly when the page boundary falls inside
   *  this company, which is the only case the header has to explain. */
  rows: Pairing[];
  threshold: number | null;
}) {
  // FRIENDS, and deliberately so: this is the number the Matched tile above is counted in, and a
  // header counting anything else would leave the reader subtracting two headline numbers to find
  // out which one the tile meant. Connections ride alongside it as a second clause.
  //
  // Counted over the WHOLE group and never over `rows`: these are facts about the company, and a
  // header that re-counted itself per page would say a different thing about BANGKOK BANK depending
  // on where the twentieth row happened to fall.
  const friends = distinctFriends(group.people);
  const leads = Math.max(0, friends - group.confirmed);
  const partial = rows.length !== pairings.length;

  return (
    <div className="overflow-hidden rounded-lg border">
      <GroupHeader
        icon={Building2}
        title={group.company}
        href={withThreshold(`/companies/${encodeURIComponent(group.company)}`, threshold)}
        tooltip={companyTooltip(friends, group.confirmed, pairings.length)}
        detail={
          <>
            {friends} {friends === 1 ? "friend" : "friends"}
            {/* Amber, and only when there are any: the split rides on the header rather than on a
                section of its own because the rows below are sorted confirmed-first, and the header
                is what tells you where the line falls. */}
            {leads > 0 && (
              <span className="text-confidence-medium">
                {" "}
                · {leads} lead{leads === 1 ? "" : "s"}
              </span>
            )}
            {/* Said only when it differs from the friend count, which is exactly when a reader
                would otherwise be counting rows and finding more of them than the header claims.
                One friend can reach several people here. */}
            {pairings.length !== friends && <span> · {pairings.length} connections</span>}
            {/* THE PAGE CUT THIS COMPANY IN HALF, and the header is the only thing that can say so.
                Without it the counts above read as a promise the rows below do not keep — "23
                connections" over four of them, with the other nineteen on the next page and nothing
                on screen to suggest it. */}
            {partial && (
              <span>
                {" "}
                · {rows.length} on this page
              </span>
            )}
          </>
        }
      />
      {rows.map((pairing) => (
        <PairingRow key={pairing.key} pairing={pairing} />
      ))}
    </div>
  );
}

/** What the header's counts are shorthand for. A company's row of numbers is three different
 *  denominators in a row, and the one nobody guesses is that friends and connections differ. */
function companyTooltip(friends: number, confirmed: number, connections: number): string {
  const leads = Math.max(0, friends - confirmed);
  const who = friends === 1 ? "1 friend reaches" : `${friends} friends reach`;
  const split =
    leads === 0
      ? "all on whole-name matches."
      : confirmed === 0
        ? "every one on a partial name, so none is confirmed — check before asking for an introduction."
        : `${confirmed} confirmed, ${leads} lead${leads === 1 ? "" : "s"} worth checking.`;
  const spread =
    connections === friends
      ? ""
      : ` They reach ${connections} people here in total — a friend can match more than one.`;
  return `${who} this company — ${split}${spread}`;
}

/**
 * ONE CONNECTION, SPELLED OUT AS A PAIRING: whose friend, called what, held against WHICH SPELLING
 * of which person at this company, and how close the two came.
 *
 * ── It is the company page's card, in a list row ──
 *
 * `ConnectionCard` already answers exactly this question one screen over, and it earned its shape
 * the hard way. This row borrows the parts rather than the markup — `Side`, `MarkedName` and
 * `Score`, all shared — so a reader moving between a company and a roster is reading one vocabulary
 * and not two renderings of the same claim.
 *
 * Three things came with it, and each replaces something this page was getting wrong:
 *
 *   · THE CONTACT SPELLING THE RUN ACTUALLY SCORED. The row led with `en` and put `th` underneath,
 *     whatever the run compared — so a `th_full` finding printed its score beside the English name,
 *     a string that was never in the comparison. `readPairing` picks the column the language axis
 *     picked, and both halves of the pairing are therefore always in one script.
 *   · THE PART THAT WAS COMPARED, marked. `surname 100%` between two whole names is unreadable
 *     until you can see that only `wongsawat` was ever held against `wongsawat`.
 *   · THE SCORE, TINTED BY THE SCORE. It was tinted by the pairing's STRENGTH, which put a green
 *     80% above an amber 100% — the same `--confidence-*` ramp carrying two meanings on one screen,
 *     with nothing to say which was in play. Strength has not been dropped: it is the gutter icon
 *     and the whole subject of the tooltip. It is just no longer painted on the number.
 *
 * ── The evidence hangs INSIDE the name column, not on a padding class ──
 *
 * The continuation lines used to be siblings of the row, pushed under the name with `pl-15` — which
 * is not a class Tailwind emits (the default scale has no `15`), so they were never indented at
 * all and read as a flat list of unrelated lines. Nesting them in the column they belong to gets
 * the alignment from the layout instead of from a number kept in sync with the gutter by hand.
 */
function PairingRow({ pairing }: { pairing: Pairing }) {
  const [lead, ...also] = pairing.findings;
  const Icon = pairing.confirmed ? UserCheck : UserSearch;

  /**
   * Every finding read as a pairing, once, here — rather than each line reading itself.
   *
   * Each read consults the OTHER findings for an alternate spelling, so doing it per line is
   * quadratic in a list that is usually two long and occasionally ten. It also puts the lead's
   * reading in scope, which is what the continuations need in order not to repeat it.
   */
  const reads = React.useMemo(
    () => pairing.findings.map((f) => readPairing(f, pairing.findings.filter((x) => x !== f))),
    [pairing]
  );

  /**
   * The contact spellings the lead line already puts on screen.
   *
   * Every finding here is about the same person, so a continuation's "other spelling" is almost
   * always a name the line above is showing — as its contact (a Thai finding under an English one)
   * or as its own alternate (a second English finding). Four lines each trailing the same
   * parenthesised name is repetition, not disclosure. A third spelling — a contact renamed between
   * runs — is not in the set and still shows.
   */
  const shownOnLead = new Set(
    [reads[0]?.contact, reads[0]?.contactAlt].filter((s): s is string => !!s)
  );

  return (
    <div className="flex items-start gap-3 border-b p-4 transition-colors last:border-b-0 hover:bg-muted/40">
      {/* The row's GRADE — what it entitles you to do — in the gutter where the eye already lands.
          Amber and a search glyph for a lead: this row is a question, not a placement. Deliberately
          the one channel strength owns now that the score chip is tinted by the measurement. */}
      <Icon
        className={cn(
          "mt-1 h-4 w-4 shrink-0",
          pairing.confirmed ? "text-confidence-high" : "text-confidence-medium"
        )}
        aria-hidden
      />

      <div className="min-w-0 flex-1 space-y-1">
        <FindingLine finding={lead} read={reads[0]} lead />

        {also.length > 0 && (
          <div className="pt-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Also found by
            </p>
            {/* The SAME two people, found again by a comparison that asked a different question —
                which is the whole reason anyone runs the second one. It reads as corroboration only
                because a different contact now starts a row of its own; before the pairing fold
                these lines could be about anybody. */}
            <ul className="mt-1 space-y-2 border-l pl-3">
              {also.map((finding, i) => (
                <li key={`${finding.runId}-${finding.mode}-${i}`}>
                  <FindingLine finding={finding} read={reads[i + 1]} alreadyShown={shownOnLead} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * ONE FINDING — the two strings this particular comparison held against each other, what it
 * measured, and how close they came.
 *
 * ── Why a continuation gets the whole pairing and not just a run name ──
 *
 * These lines used to be `Company · BANGKOK BANK — full name · Thai 100%`: the run and the score,
 * and not one of the names either belonged to. That reads as a footnote on the row above ("the same
 * thing, again"), which understates what it is. A pairing's findings agree about WHO; they disagree
 * about almost everything a reader would want to check:
 *
 *   · WHICH SPELLINGS. A `th_full` finding scored `ดวงกมล นครทรัพย์` against `ดวงกมล นครทรัพย์`;
 *     the `en_full` line above it scored two Latin strings. Two independent spellings agreeing is
 *     markedly stronger evidence than either alone — and it was invisible, because neither Thai
 *     string was on screen.
 *   · WHICH PART. `given name · English 100%` and `surname · English 100%` on consecutive lines are
 *     the same two names underlined in two different places, and the underline is the only thing
 *     that distinguishes a claim about `duangkamol` from a claim about `nakornthap`.
 *
 * So every line is the same component, and the lead is not a different kind of thing — it is simply
 * the strongest finding, drawn first and in a heavier weight.
 */
function FindingLine({
  finding,
  read,
  lead = false,
  alreadyShown,
}: {
  finding: MatchedPerson;
  /** This finding read as a pairing — computed once by `PairingRow`, which is the only scope that
   *  can see the sibling findings each read consults. */
  read: ScoredPairing;
  /** The pairing's strongest finding — the one that states the connection, rather than corroborating
   *  it. Weight only: nothing about the claim differs. */
  lead?: boolean;
  /** Contact spellings the lead line is already showing, so a continuation does not repeat them. */
  alreadyShown?: Set<string>;
}) {
  const mode = parseCompareBy(finding.mode);
  const { type } = compareByAxes(mode);
  const thai = read.language === "th";
  const weight = lead ? "font-medium" : undefined;
  const showAlt = read.contactAlt && !alreadyShown?.has(read.contactAlt);
  // The citation below leaves this page for a run. Read off the URL rather than threaded down four
  // components from the section — the bar is a property of where the reader is standing, and the
  // threading is what let the run page lose it in the first place. See `useCarriedThreshold`.
  const threshold = useCarriedThreshold();

  /**
   * The caveats — rendered only when there is one, so an ordinary line is one line and not two.
   *
   * Both say how far this finding departs from what its run was configured to do, which is why they
   * share a line and a colour. Neither is reachable on a run the internal matcher wrote; both are
   * reachable on this database, which is why they are here and not assumed away.
   */
  const notes: { text: string; title: string }[] = [];
  if (read.languageMismatch) {
    notes.push({
      text: `set to compare ${compareByLabel(mode)}, but recorded ${LANGUAGE_LABEL[read.language]} names — what this score measured is unconfirmed`,
      title: `This run's mode is ${compareByLabel(mode)} and the matcher recorded ${LANGUAGE_LABEL[read.language]} spellings for this pairing, so it did not follow the mode. Nothing on the row records which part of the names it did compare, which is why the score carries no unit. Treat it as a resemblance between the two names shown, and check the pairing before acting on it.`,
    });
  }
  if (read.contactIsFallback) {
    notes.push({
      text: "compared on the contact's other spelling",
      title: `This run recorded no ${LANGUAGE_LABEL[read.language]} name for the contact, so the pairing shows the spelling that survives rather than the one it scored.`,
    });
  }

  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        {/* THE PAIRING. Friend on the left, contact on the right, the arrow meaning "was compared
            against" — and each side wearing its role, because two Thai names either side of an
            arrow are symmetrical to look at and are not symmetrical at all. Read backwards this line
            claims a relationship that does not exist, and it still carries a percentage.

            The labels ride on the continuations too, and not only on the lead. They cost two grey
            words at `text-2xs`; dropping them would make the one line on the row that is NOT
            self-describing the one a reader is most likely to meet out of context, after the row
            above it has scrolled away. */}
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
          <Side
            label="friend"
            hint="Someone on this owner's list — the name this run held against the contact. They are who you ask for the introduction."
          >
            <MarkedName name={finding.friend} type={type} lang={thai ? "th" : undefined} className={weight} />
          </Side>

          <ArrowRight
            className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground"
            aria-label="was compared against"
          />

          <Side
            label="contact"
            hint="The person on file at this company — the one this connection would introduce you to."
          >
            {read.contact ? (
              <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                <MarkedName
                  name={read.contact}
                  type={type}
                  lang={!read.contactIsFallback && thai ? "th" : undefined}
                  className={weight}
                />
                {/* A spelling we hold for this person that this run did NOT score. Muted,
                    parenthesised and deliberately unmarked, so it cannot be mistaken for the string
                    that earned the number. Suppressed on a continuation whose lead already shows
                    it — see `shownOnLead`. */}
                {showAlt && read.contactAlt && (
                  <span
                    lang={thai ? undefined : "th"}
                    className="text-muted-foreground"
                    title={`Also on file as ${read.contactAlt}. This spelling was not the one scored.`}
                  >
                    ({read.contactAlt})
                  </span>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground" title="This run recorded no name for the contact it matched.">
                this contact
              </span>
            )}
          </Side>
        </p>

        {notes.length > 0 && (
          <p className="text-xs text-confidence-medium">
            {notes.map((n, i) => (
              <span key={n.text} title={n.title}>
                {i > 0 && " · "}
                {n.text}
              </span>
            ))}
          </p>
        )}

        {/* WHICH COMPARISON SAID SO — provenance, so it sits under the claim rather than in front
            of it. It led these lines while they had nothing else on them; now that the pairing is
            there, the run is the smaller fact and reads as the citation it is. Only on the
            continuations: the lead's run is in its score tooltip, and a line under every row on the
            page would cost height on the great majority of pairings, which have exactly one
            finding. */}
        {!lead && (
          <p className="text-xs">
            <Link
              href={withThreshold(`/comparisons/${finding.runId}`, threshold)}
              className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {runLabel(finding)}
            </Link>
          </p>
        )}
      </div>

      <FindingScore finding={finding} className="mt-0.5" />
    </div>
  );
}

/**
 * One finding's score, through the SHARED `Score` — so a percentage's hue means the same thing here
 * as on a company page and in the run table: how close the two names came, and nothing else.
 *
 * The unit is the qualifier AND the language, which is the whole of what the number measured. It
 * goes to null on a row whose own evidence contradicts its mode, because there the type axis is not
 * supportable either: `narong sinthu` against `narong sinthu` scores 100% as a full name, a given
 * name or a surname, and the three are indistinguishable from what is stored. An unsupported label
 * is worse than an absent one — it survives screenshots.
 */
function FindingScore({ finding, className }: { finding: MatchedPerson; className?: string }) {
  const language = readPairing(finding).language;
  const mode = parseCompareBy(finding.mode);
  const mismatch = language !== compareByAxes(mode).language;
  const unit = mismatch ? null : `${scoreQualifier(mode)} · ${LANGUAGE_LABEL[language]}`;
  return (
    <span
      title={`${matchReason(mode, formatSimilarity(finding.similarity))} Found by ${runLabel(finding)}.`}
      className={cn("shrink-0", className)}
    >
      <Score value={finding.similarity} qualifier={unit} />
    </span>
  );
}
