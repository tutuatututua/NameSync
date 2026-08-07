"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GitCompareArrows } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LoadingButton } from "@/components/loading-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Callout } from "@/components/callout";
import { CompanyPicker } from "@/components/company-picker";
import { SourcePicker, friendsInSelection } from "@/components/source-picker";
import { CompareModeControl } from "@/components/compare-mode";
import {
  ALL_COMPANIES_LABEL,
  DEFAULT_COMPARE_BY,
  compareByLabel,
  scopeLabel,
  scopeTooltip,
  sourcesLabel,
  type CompareBy,
  type RequestedScope,
} from "@extensions/contract";
import { formatCompanies, formatRelativeTime } from "@/lib/format";
import { useCompanies, useDuplicateRun, useUploadSources } from "@/hooks/queries";
import { useCarriedThreshold, withThreshold } from "@/hooks/useThreshold";
import { useCompareByCompany } from "@/hooks/mutations";

/**
 * Run an ad-hoc comparison against a chosen set of companies.
 *
 * A secondary action, not a tab: with the external matcher an import already matches against
 * everything on file, so this is for the occasional "just these companies" run. On success it
 * hands off to the run's own page (`/comparisons/:id`) — the one canonical place a run is watched
 * and read — rather than an in-place state machine.
 *
 * ── Why the copy scales with the selection ──
 *
 * "Each person keeps their single closest match across the set" is true at one company and at four
 * hundred, but it costs nothing at one and costs most of your map at four hundred — so a fixed
 * sentence describing both is only accurate at the small end. The picker's select-all removed the
 * friction that used to hide this; it did not create the hazard (the picker was always unbounded),
 * which is why this dialog now states the cost rather than the picker refusing the selection.
 *
 * Semantic loss is stated before the wait: the wait is recoverable and the dropped connections are
 * not. `POST /compare` also runs to completion before responding and scores friends × contacts on
 * the API's single thread, so a large run blocks the event loop and looks like a hang.
 */
/** Where a muted line stops being enough and the run needs a box the reader has to get past. */
const BULK_THRESHOLD = 10;

/*
 * An "Open results at" slider stood here, carrying a bar to the run page as `?threshold=`.
 *
 * It went with the run page's own control (2026-07-31). Its whole job was to pre-set that control,
 * so with the control gone it was a setting that reached nothing — and the thing it was reaching
 * for has moved anyway: the bar now tunes the pooled Network answer rather than a single run. The
 * mode below stayed, because that IS a parameter of the run: it changes what the matcher asks, and
 * changing it needs a new run.
 */
/**
 * Where a run opened from somewhere else starts — the companies and sources it should arrive
 * holding, so "ask this again, differently" does not begin by re-picking what you already had.
 *
 * `companies` follows CompanyPicker's three states: omitted is unanswered, `null` is every company,
 * a list is those. The mode is deliberately NOT seedable — see `seedLine`.
 */
export type ComparisonSeed = {
  companies?: string[] | null;
  sources?: string[] | null;
  /**
   * The mode to arrive holding — and the ONE case where seeding it is right.
   *
   * Omitted from a re-run opened off a finished run, deliberately: there the mode is the axis you
   * came to change, and pre-filling it with the answer you are moving away from is the one place
   * inheritance actively works against the reader.
   *
   * Set when the user ALREADY CHOSE a mode and the app could not honour it — which is exactly the
   * duplicate-import case. The import screen carries its own "How to compare", the choice is sent
   * with the file, and an import that adds no rows opens no run, so there is nothing for the choice
   * to apply to and it is discarded. Carrying it here is not stickiness; it is the difference
   * between honouring an explicit answer and silently dropping it, which is what this did until
   * 2026-08-04 and what made "I re-uploaded with a different mode and nothing changed" the obvious
   * (and correct) reading of the screen.
   */
  compareBy?: CompareBy;
};

export function NewComparisonDialog({
  open,
  onOpenChange,
  initial,
  scope,
  scopeSelects,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fill for a run opened from a finished run or a duplicate import. See `ComparisonSeed`. */
  initial?: ComparisonSeed;
  /**
   * WHICH ROWS this run covers — set when the dialog was opened from a company row, a relationship
   * owner or a past import, which since 2026-08-06 is every way in but one. Omitted is the
   * whole-table run, now reachable only by re-running one that was already unscoped; it picks its
   * rows with the company and source pickers below.
   *
   * ── A SCOPE IS NOT A SEED, AND THE DIFFERENCE IS THAT IT IS NOT EDITABLE ──
   *
   * `initial` pre-fills controls the reader may then change; this replaces them. Somebody who
   * pressed Compare on BlueBrick's row asked about BlueBrick, and offering a company picker under
   * that heading would invite them to edit the one part of the question that was already answered —
   * and produce a run whose stored scope said one thing and whose companies said another.
   *
   * So the picker is not rendered at all when this is set, and the scope is stated instead. What
   * stays editable is exactly what the entry point did NOT answer: the mode, and the friend sources
   * when the scope did not already settle them — see `scopeSelects`.
   */
  scope?: RequestedScope;
  /**
   * WHICH SIDE the scope picked, from the server (`ComparisonListItemSchema`).
   *
   * Undefined or null means "not known / nothing scoped", and every control stays.
   */
  scopeSelects?: "friends" | "companies" | null;
}) {
  const router = useRouter();
  /** Written by the company picker (already debounced); the options follow it from the server. */
  const [companyQuery, setCompanyQuery] = React.useState("");
  const companies = useCompanies(companyQuery);
  const uploadSources = useUploadSources();
  const compareMut = useCompareByCompany();
  // `[]` is UNANSWERED and `null` is every company — CompanyPicker's header argues both.
  const [selected, setSelected] = React.useState<string[] | null>([]);
  const [compareBy, setCompareBy] = React.useState<CompareBy>(DEFAULT_COMPARE_BY);
  // Null is every source, and it is the resting value rather than an unset one — see SourcePicker.
  const [sources, setSources] = React.useState<string[] | null>(null);
  /**
   * What this dialog was opened WITH, in words — null when it was opened empty.
   *
   * Held in state rather than derived from `initial`, so it keeps saying where the run started
   * after the reader has changed something. That is the whole point of it: a pre-filled field the
   * user then edits should still be able to explain why it was not blank.
   */
  const [seedLine, setSeedLine] = React.useState<string | null>(null);

  /**
   * Fresh selection, mode and sources each time it opens — unless the caller seeded it.
   *
   * The reset exists because these are per run, not preferences: a surname run last Tuesday should
   * not silently decide what today's run means, and neither should last Tuesday's decision to look
   * only at LinkedIn — that one is worse, because it silently shrinks the answer instead of
   * changing it.
   *
   * A SEED IS NOT THAT, AND THE DIFFERENCE IS THAT IT IS SAID OUT LOUD. Stickiness is a value the
   * reader did not choose and is not told about; `initial` arrives because they clicked "compare
   * these again" on a specific run, and `seedLine` puts what it carried on the screen.
   *
   * The MODE is seeded only when the caller passes one, and only one caller does — the duplicate
   * import, carrying the choice the user made on the import screen that the import could not use.
   * See `ComparisonSeed.compareBy` for why that is the opposite of stickiness rather than an
   * exception to it. Everywhere else it resets to the default, because there it IS the axis the
   * re-run exists to change.
   *
   * `initial` is read through a ref rather than listed as a dependency: callers pass an object
   * literal, whose identity changes on every render, and an effect that setState'd on each of those
   * would never stop.
   */
  const initialRef = React.useRef(initial);
  initialRef.current = initial;
  // Read the same way and for the same reason — the effect below wants the scope it was opened
  // with, without listing an object literal as a dependency.
  const scopeRef = React.useRef(scope);
  scopeRef.current = scope;
  // And the side it selected, for the same reason: the seed line has to know which controls are
  // going to be on screen before it describes what they were filled with.
  const selectsRef = React.useRef(scopeSelects);
  selectsRef.current = scopeSelects;

  React.useEffect(() => {
    if (!open) {
      setSelected([]);
      setCompareBy(DEFAULT_COMPARE_BY);
      setSources(null);
      setSeedLine(null);
      // The picker clears its own box on close and would push this back through the debounce
      // anyway; doing it here too means the next open reads the unsearched list immediately rather
      // than 300ms later, which is the difference between opening on the whole list and opening on
      // the last search's leftovers.
      setCompanyQuery("");
      return;
    }
    const seed = initialRef.current;
    if (!seed) return;
    const nextCompanies = seed.companies === undefined ? [] : seed.companies;
    const nextSources = seed.sources === undefined ? null : seed.sources;
    const nextMode = seed.compareBy ?? DEFAULT_COMPARE_BY;
    setSelected(nextCompanies);
    setSources(nextSources);
    setCompareBy(nextMode);
    // The mode goes in the line only when it was seeded. Naming the DEFAULT there would claim the
    // caller chose it, which is the one thing this line exists not to do.
    //
    // The COMPANIES go in it only when the picker is on screen, for the stronger reason: this line
    // exists to explain why a field is not blank, and a scoped run has no company field to explain.
    // Naming companies there would describe a narrowing the run will not apply — its company side
    // comes from the scope — and point at a control the reader could then not find.
    // The SOURCES go in it only when their picker is on screen, on exactly the reasoning the
    // companies follow one line up: a friend-side-scoped run has no source field to explain, its
    // run is submitted with none, and "Starting from Facebook" over a dialog with no source control
    // would describe a narrowing that is not being applied and point at a control that is not there.
    const showsSources = selectsRef.current !== "friends";
    setSeedLine(
      [
        ...(scopeRef.current === undefined
          ? [
              nextCompanies === null
                ? ALL_COMPANIES_LABEL
                : formatCompanies(nextCompanies, { conjunction: "and" }) ?? ALL_COMPANIES_LABEL,
            ]
          : []),
        ...(showsSources ? [sourcesLabel(nextSources)] : []),
        ...(seed.compareBy ? [compareByLabel(seed.compareBy)] : []),
      ]
        .filter(Boolean)
        .join(" · ")
    );
  }, [open]);

  /**
   * How many companies exist AT ALL — the server's count, not the length of the page it returned.
   *
   * Read with no search applied, because that is the question: `companyQuery` narrows what the
   * picker offers, and "how big is a whole-database run" must not move while somebody types. It is
   * held from the first load rather than re-read, since `total` under an active search answers a
   * different question entirely.
   */
  const companiesOnFile = React.useRef(0);
  if (!companyQuery && typeof companies.data?.total === "number") {
    companiesOnFile.current = companies.data.total;
  }

  /**
   * Is this dialog answering a question the caller already narrowed?
   *
   * Read once and used everywhere below, because it changes several things at the same time and
   * they have to change together: the duplicate check asks a scoped question, the heading names the
   * scope, and the run is submitted with the pair attached.
   */
  const scopedRun = scope !== undefined;
  const scopeText = scopedRun ? scopeLabel(scope.filterBy, scope.filterValue) : null;

  /**
   * DOES THE READER STILL CHOOSE THE COMPANIES? — only when nothing was scoped.
   *
   * A SCOPED RUN NEVER SHOWS THE PICKER (2026-08-07). It was shown under an `owner` scope for a
   * day, on the reasoning that a scope names one side and `owner` names the FRIEND side, so the
   * company side was still an open question worth asking — "Mint's friends at BANGKOK BANK".
   *
   * What that reasoning missed is what the dialog looks like once it is on screen: somebody who
   * pressed Compare on a row has already said what they want, and a required-looking select sitting
   * under a heading that names their answer reads as a second question they must get right before
   * anything happens. Both matchers still compose the two narrowings — nothing below or in the API
   * changed — but a scoped run now asks for the companies the way it always did before, which is
   * not at all: every company on file.
   *
   * So the picker belongs to exactly one run, the unscoped one, where it is not a narrowing but the
   * whole question — there is no scope to derive the rows from, and without it the dialog would
   * have nothing to ask.
   */
  const picksCompanies = !scopedRun;

  /**
   * DOES THE READER STILL CHOOSE THE FRIEND SOURCES? — not when the scope already picked the
   * friends.
   *
   * ── WHY A FRIEND-SIDE SCOPE ENDS THIS QUESTION (2026-08-07) ──
   *
   * "Friend sources" narrows WHICH FRIENDS are in the run. So does a scope that selects friends —
   * an owner ("Nalinee's friends") or an import of a friend list ("every row of import 12"). When
   * both are set the server applies both (`MatchScope` plus `sources`, on either matcher), and the
   * second one has no useful answer left to give:
   *
   *   · An import carries exactly ONE source — it is a column on `upload`, written once for the
   *     whole file. So on a file-scoped run every option is either that source, which changes
   *     nothing, or another one, which selects nobody and produces a run that matched zero of zero.
   *   · The count under the picker makes it worse rather than better. It reads
   *     `useUploadSources`, which counts every friend on file from that source — so a dialog over a
   *     50-row import cheerfully offers "993 Facebook friends", describing a population 20× the one
   *     the run will actually read.
   *   · The API's guard does not catch it either: the "no friends from that source" 400 counts
   *     GLOBALLY (`FriendModel.countBySource`), so a source that exists anywhere passes the check
   *     and the empty run gets written.
   *
   * An owner scope is the same shape with a softer edge — an owner CAN hold friends from two
   * sources, so "Alex's LinkedIn friends" is a question the API still answers. It is dropped here
   * anyway, and deliberately: the dialog's heading already names the population, and a second
   * friend-side filter under it reads as a narrowing of something that was presented as settled.
   * Anyone who wants that combination is asking a different question, and the unscoped run is where
   * questions get composed from both sides.
   *
   * A COMPANY-side scope keeps the picker, which is the whole reason this is a side and not a
   * boolean about scoping: a company, or an import of CONTACTS, narrows the other half of the run
   * and leaves "against whose friends" genuinely open.
   */
  const picksSources = scopeSelects !== "friends";

  const hasCompanies = companiesOnFile.current > 0;
  /** Every company on file, chosen as a standing answer rather than as a list of names. */
  const allCompanies = selected === null;
  /**
   * How many companies this run covers — the number every warning below is scaled by.
   *
   * For an all-companies run that is the whole table, which is exactly why the bulk warning has to
   * read it from here and not from `selected.length`: "all companies" at a database with 400 of
   * them is the single largest run this dialog can start, and it is the one that would otherwise
   * report a selection size of zero and warn about nothing.
   *
   * Sourced from the server's `total` since the picker started searching (2026-08-04). It used to
   * be `companies.data.length`, which was the same number only while the client held every company;
   * against a capped, searched list that expression would have told someone their whole-database
   * run covered 50 companies — and, worse, silently dropped it under the bulk threshold, so the
   * largest run in the app would have stopped warning about itself.
   */
  const companyCount = allCompanies ? companiesOnFile.current : selected.length;

  /**
   * Has this exact question been asked before — and would asking it again read anything new?
   *
   * Read live as the selection changes, so the answer is already on screen by the time someone
   * reaches for Run rather than arriving after they press it.
   *
   * `blocked` is the SERVER'S verdict and not `priorRun !== null`, deliberately. The second half of
   * the rule ("…and nothing has moved since") is a question about rows this component cannot see,
   * so inferring it here would eventually disagree with the 409 `POST /compare` answers with — and
   * a disabled button the server would have accepted is indistinguishable from a broken one.
   *
   * Absent while the query is in flight, which resolves to NOT blocked: a button that starts
   * disabled and enables a moment later trains people to press it twice, and the write path refuses
   * the run anyway if the answer lands the other way.
   */
  /**
   * The source answer this run will actually be SUBMITTED with — null whenever the picker is not on
   * screen, exactly as `companyNames` is null whenever the company picker is not.
   *
   * Read by the duplicate check as well as by `run()`, and that is the point of naming it once: the
   * check has to ask about the run that will be created, or it would clear a question the server
   * then refuses (or refuse one it would have accepted). `sources` state cannot drift from null
   * while the picker is hidden — nothing can set it — but a value derived from what is RENDERED is
   * the version that stays true if that ever stops being so.
   */
  const effectiveSources = picksSources ? sources : null;

  const duplicate = useDuplicateRun(
    picksCompanies ? selected : null,
    compareBy,
    effectiveSources,
    scope
  );
  const priorRun = duplicate.data?.run ?? null;
  const priorCount = duplicate.data?.runCount ?? 0;
  const blocked = duplicate.data?.blocked ?? false;
  // "Open that run" leaves for a run page, and this dialog opens from every workspace surface —
  // so it is one of the doors the tuned bar has to survive. Undefined (and so a plain href) when
  // the dialog is opened from a page that has no bar. See `useCarriedThreshold`.
  const threshold = useCarriedThreshold();

  /** What the company side amounts to, in words — for the "you already ran this" sentence. */
  const companiesPhrase = allCompanies
    ? "every company on file"
    : selected.length === 1
      ? selected[0]
      : `these ${selected.length} companies`;

  const sourceList = uploadSources.data ?? [];
  const friendCount = friendsInSelection(sources, sourceList);
  const sourceNames = sourcesLabel(
    effectiveSources,
    new Map(sourceList.map((s) => [s.value, s.label]))
  );

  async function run() {
    // Null is a real answer (every company); only the unanswered empty list is refused. A run with
    // no picker on screen has nothing to leave unanswered — its companies come from the scope.
    if (picksCompanies && selected !== null && selected.length === 0) return;
    try {
      const data = await compareMut.mutateAsync({
        // NO SCOPED RUN SENDS A COMPANY LIST. A company-scoped one because the server derives it
        // from `filter_value` and stores both, so our own copy would be a second spelling of one
        // answer that could disagree with it; an owner- or file-scoped one because there is no
        // picker to have answered it (see `picksCompanies`) and `null` is every company on file.
        companyNames: picksCompanies ? selected : null,
        compareBy,
        // NO FRIEND-SIDE-SCOPED RUN SENDS A SOURCE LIST, for the same reason no scoped run sends a
        // company list: there is no picker to have answered it, and null is every source — which
        // for a run whose friends are already fixed is the only truthful answer. See `picksSources`.
        sources: effectiveSources,
        scope,
      });
      onOpenChange(false);
      router.push(`/comparisons/${data.sessionId}`);
    } catch {
      /* the mutation surfaces the error as a toast */
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        WIDER AND SCROLLABLE, rather than the shared `max-w-lg`.

        This is the widest dialog in the app because it is the only one that is a form with four
        answers in it — companies, sources, name part, language — where the rest confirm or destroy
        one thing. At `lg` the company picker's selected chips wrapped to three or four lines and
        pushed the callouts below the fold; the two selects in "How to compare" also sit side by
        side and were cramped.

        `max-h`/`overflow-y-auto` come WITH the width and are not decoration: the dialog primitive
        centres a `fixed` box and does not bound its height, so the duplicate callout and the bulk
        callout appearing together already ran off the bottom of a short viewport with no way to
        reach Cancel. Set here rather than on `DialogContent` itself, because every other dialog in
        the app is short by construction and a scroll container they never fill is a scrollbar that
        flickers on open.
      */}
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          {/* The title the BUTTON said, deliberately. A dialog that renames the thing you just
              clicked reads as a different feature, and the disambiguation this screen needs does
              not belong in a heading — it belongs in the description below, where there is room to
              say it in words. */}
          {/* The title the BUTTON said, deliberately — see above. A scoped dialog names its scope
              instead, for the same reason: it was opened from a row, and a heading that dropped
              what the row was would make the reader check they clicked the right one. */}
          <DialogTitle>{scopeText ?? "Find connections"}</DialogTitle>
          {/* The "one run, not one per company" half of this sentence moved to the
              selection-aware copy below, where it can carry the actual count. Saying it here too
              would state it twice on every selection that already gets the concrete version.
              "Creates a new run" is stated outright, and this sentence is now where the whole
              read/write distinction is carried: the fields below look like filters and three of
              them are shaped like filters, so the line that frames them has to say that answering
              them writes rows rather than narrowing a view. */}
          {/* No scope says anything about companies any more, because none of them asks for any:
              the picker is the unscoped run's alone (see `picksCompanies`), and a sentence offering
              a choice the dialog does not then present is worse than one that stays quiet. */}
          <DialogDescription>
            {scopedRun
              ? `${scopeTooltip(scope.filterBy, scope.filterValue)} This creates a new run.`
              : "Score every uploaded person against the companies you pick. This creates a new run."}
          </DialogDescription>
        </DialogHeader>

        {/* Where this came from, when it came from somewhere. Stated rather than silent — a
            pre-filled form that does not explain itself is indistinguishable from a sticky one,
            and the reason those are reset here is that they were never chosen for THIS run. */}
        {seedLine && (
          <p className="text-sm text-muted-foreground">
            Starting from <span className="font-medium text-foreground">{seedLine}</span>. Change
            anything below.
          </p>
        )}

        {/*
          THE COMPANY PICKER IS THE THING A SCOPE REPLACES — any scope, since 2026-08-07.

          Every other control in this dialog stays: the mode and the sources were not answered by
          clicking a company row, an owner row or an import row. This one is either answered by the
          scope (a company row), or not worth re-asking under it (an owner or file row, where the
          run covers every company on file the way it always has). See `picksCompanies`.

          Rendering it disabled was the alternative and is worse: a greyed picker over a heading
          that already names the scope reads as a control that has failed rather than one that does
          not apply, and it leaves the reader looking for the way to enable it.
        */}
        {picksCompanies && (
        <div className="space-y-1.5">
          <Label htmlFor="new-compare-companies">Companies</Label>
          <CompanyPicker
            id="new-compare-companies"
            companies={companies.data?.companies ?? []}
            total={companies.data?.total ?? 0}
            isLoading={companies.isFetching}
            onQueryChange={setCompanyQuery}
            selected={selected}
            onChange={setSelected}
            disabled={!hasCompanies}
            placeholder={hasCompanies ? "Select companies…" : "No companies yet"}
          />
          {!hasCompanies && !companies.isLoading && (
            <p className="text-sm text-muted-foreground">
              Import company data first to have something to compare against.
            </p>
          )}

          {/* An all-companies run under the bulk threshold still says what it covers, and says it
              as a count — "all companies" is the one selection whose size is not on screen. */}
          {allCompanies && companyCount < BULK_THRESHOLD && (
            <p className="text-sm text-muted-foreground">
              Every person will be scored against every contact at all {companyCount} companies on
              file — one run, not one per company.
            </p>
          )}
          {!allCompanies && selected.length === 1 && (
            <p className="text-sm text-muted-foreground">
              Every person will be scored against the contacts at {selected[0]}.
            </p>
          )}
          {!allCompanies && selected.length > 1 && selected.length < BULK_THRESHOLD && (
            <p className="text-sm text-muted-foreground">
              Each person keeps their single closest match across these {selected.length} companies
              — one run, not one per company.
            </p>
          )}
        </div>
        )}

        {/* Still keyed on the PICKER being on screen rather than on the count alone: a scoped run
            covers every company on file and cannot be talked out of it, so a warning about the size
            of a selection would be describing a decision the reader was never offered. */}
        {picksCompanies && companyCount >= BULK_THRESHOLD && (
          <Callout tone="warning" title="One match per person — not one per company.">
            <p>
              Someone who knows people at several of these {companyCount} companies will produce
              a single row: their closest match anywhere. To see every company a person reaches, run
              smaller sets.
            </p>
            <p>
              This also scores every person against every contact on file and finishes before the
              page responds, so expect it to take a while.
            </p>
          </Callout>
        )}

        {/*
          ONE BLOCK: sources, name part, language.

          These three are the run's settings, and they were briefly split — sources in their own
          section above, on the reasoning that a source picks a POPULATION (like companies) where
          the mode is a RULE applied to whoever is in it. That taxonomy is real but it is not what
          anybody does with this dialog.

          What they do is re-run. A repeat run keeps the same companies and changes the mode or the
          sources — those two ARE the re-run key (see the duplicate check), so they are the pair a
          returning user comes here to touch. Splitting them across two sections put the two most
          exercised controls furthest apart and made the boundary between them look meaningful,
          which it is not: "LinkedIn friends, by surname, in Thai" is one question, not a population
          plus a setting.

          Companies stay outside, above. That one is the TARGET rather than a setting, it is
          required where all three of these have defaults, and it is the field a first-time user
          must fill in before anything can happen.
        */}
        <div className="space-y-3 border-t pt-4">
          <p className="text-sm font-medium">How to compare</p>

          {/* Sources FIRST within the block: it decides who is in the run, and the other two only
              have meaning once there is somebody for them to apply to.

              ABSENT ENTIRELY when the scope already picked the friends (see `picksSources`) — not
              disabled, for the reason the company picker is not: a greyed control under a heading
              that names the answer reads as something that has failed rather than something that
              does not apply, and leaves the reader hunting for the way to switch it on. The mode
              below stays either way; it is a rule about how names are compared, not about who is
              in the run, so a friend-side scope leaves it genuinely open. */}
          {picksSources && (
          <div className="space-y-1.5">
            {/*
              "Friend sources", NOT "Whose friends" — which is what it said, and which was the same
              phrase the Network page put on its roster filter two inches above this dialog. (That
              label is gone as of 2026-08-06; the collision it caused is not the reason this one is
              named the way it is, and the name stays right either way.)

              The two never meant the same thing. That control filters by `friend.relationship_owner`
              — WHOSE relationship a friend is. This one picks upload SOURCES (Facebook, LinkedIn) —
              which files the run draws from. One collides on people, the other on provenance, and a
              reader who had just used the first to narrow to one owner reasonably read this as the
              same field pre-answered. Naming it for what it selects is the whole fix.
            */}
            <Label htmlFor="new-compare-sources" className="text-xs">
              Friend sources
            </Label>
            <SourcePicker
              id="new-compare-sources"
              selected={sources}
              onChange={setSources}
              disabled={compareMut.isPending}
            />
            {/*
              One line, always present, always concrete — this is the field's whole justification.
              Narrowing to LinkedIn is only a decision if the reader can see it costs them 1,204
              Facebook friends, and a count that appeared only once you narrowed would make the
              default look like it had no size at all.

              It sits directly under the picker rather than at the foot of the block, so it cannot
              be read as a gloss on the two selects below — `CompareModeControl` ends with its own
              explanation line, and two summaries in one box would compete for the same job.
            */}
            {sourceList.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {sources === null
                  ? `All ${friendCount.toLocaleString()} friends on file, whatever they were imported from.`
                  : friendCount === 0
                    ? `No friends have been imported from ${sourceNames} yet.`
                    : `${friendCount.toLocaleString()} ${sourceNames} friend${friendCount === 1 ? "" : "s"}.`}
              </p>
            )}
          </div>
          )}

          {/*
            THE ONLY PLACE THE MODE IS CHOSEN, since 2026-08-05. The import screen carried a copy of
            this control and no longer does — an import is always `en_full` — so a `th_surname` run
            is something asked for here, over rows already on file, rather than something you get by
            uploading a file a second time.

            Which matcher honours it depends on the run: an unscoped one is computed in-process, and
            a scoped one under `EXTERNAL_MATCHER` is handed to the workflow with the mode in its
            headers. The two must mean the same thing, or a run labelled "Surname · Thai" would be
            two different questions depending on a flag the reader cannot see — which is why the
            vocabulary and the splitter both live in the contract rather than at either end.
          */}
          <CompareModeControl
            idPrefix="new-compare"
            value={compareBy}
            onChange={setCompareBy}
            disabled={compareMut.isPending}
          />
        </div>

        {/*
          "You already ran this" — the same three axes, already answered.

          IT IS A REFUSAL NOW (2026-08-06), where it used to be a note the reader could press
          through. What made that safe is that the server does not ask "have you run this" but "have
          you run this AND has nothing it reads moved since" — so the one case the old advisory copy
          existed for (friends imported since the last one) unblocks the button by itself, without
          anybody deleting a good run to be allowed to repeat it. See `DuplicateRunQuerySchema`.

          Both states are rendered from here, because they are one fact told at two strengths: a
          duplicate that is NOT blocked still deserves saying out loud, and it is the same run being
          pointed at either way. What changes is the second paragraph — whether it offers the repeat
          or says what would make it possible — because a refusal that does not name its own way out
          reads as a broken screen rather than as an answer.

          Rendered only for a run that produced something: a FAILED prior run is excluded server
          side, because pointing at a failure as a reason not to retry is exactly backwards.
        */}
        {priorRun && (
          <Callout
            tone={blocked ? "danger" : "warning"}
            title={
              blocked
                ? "You have already run this."
                : "You have already run this — but the data has moved since."
            }
          >
            <p>
              {compareByLabel(compareBy)} · {sourceNames}, against{" "}
              {/* The scope when there is one, the selection when there is not — never both, because
                  the two are never both answered: a scoped run has no picker to answer with. */}
              {scopeText ?? companiesPhrase}{" "}
              —{" "}
              {priorRun.status === "completed"
                ? `${priorRun.matchCount.toLocaleString()} match${priorRun.matchCount === 1 ? "" : "es"} of ${priorRun.scoredCount.toLocaleString()} scored`
                : "still running"}
              , {formatRelativeTime(priorRun.createdAt)}.
              {priorCount > 1 && ` (${priorCount} runs match this exactly.)`}
            </p>
            <p>
              <Link
                href={withThreshold(`/comparisons/${priorRun.id}`, threshold)}
                className="font-medium underline underline-offset-4"
                onClick={() => onOpenChange(false)}
              >
                Open that run
              </Link>{" "}
              {blocked
                ? "— nothing it covers has been imported or edited since, so running it again would score the same friends against the same contacts and land on the same answer."
                : "— or run it again. Rows this run covers have changed since, so it can come back different; it adds a second set of rows rather than replacing the first."}
            </p>
            {/* The way out, named. It is the whole difference between a rule and a dead end — and
                it is the ordinary next thing anyway, since somebody re-asking a question they
                already have an answer to is usually here because they have new people to ask it
                about. */}
            <p>
              {blocked
                ? "To run it again, import the friends or contacts you want it to cover — this unblocks by itself once they land. Or change the mode or the sources above to ask a different question."
                : "To ask a different question instead, change the mode or the sources above."}
            </p>
          </Callout>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={compareMut.isPending}>
            Cancel
          </Button>
          {/* The last guard, and deliberately not a confirm step: a confirm modal on top of a modal
              gets clicked through, where a button that names its own scope cannot be pressed
              without reading what it does. Costs nothing and adds no step. */}
          {/*
            Also disabled when the source selection has nobody in it. The API refuses that run with
            a 400 (it could only ever come back empty), and a button that submits a request the
            server is certain to reject is a worse way to say so than a button that will not press.

            And when the run is a duplicate the server would refuse — same rule, same reason. The
            409 is the enforcement (see `POST /compare`); this is so nobody meets it by pressing a
            button that looked available.
          */}
          <LoadingButton
            variant="gradient"
            isLoading={compareMut.isPending}
            /* `[]` is unanswered and blocks; `null` is "every company" and does not. */
            disabled={
              blocked ||
              (picksCompanies && selected !== null && selected.length === 0) ||
              // Keyed on the SUBMITTED value, not the state: with the picker hidden this is always
              // null, so an empty-source run is not a shape this dialog can be in — and a stale
              // `sources` behind a control nobody can see must not be able to disable the button
              // with no visible cause.
              (effectiveSources !== null && friendCount === 0)
            }
            onClick={run}
          >
            <GitCompareArrows className="h-4 w-4" />
            {/* "Run & compare", not "Run comparison" (2026-08-06). Both halves are load-bearing and
                the old label only carried one of them: this READS the rows already on file and
                COMPARES them, and "comparison" on its own named the row the answer gets stored in,
                which is our bookkeeping rather than the reader's intent. The ampersand keeps the
                two verbs in one control rather than making the reader infer the read from a noun.

                It stays a verb phrase for the same reason it always was one: the DESCRIPTION above
                says outright that this creates a new run, and the button says what the reader is
                doing. Neither can be dropped — the label is what the action is FOR, that sentence
                is what it COSTS.

                The duplicate wording outranks the bulk wording, and a REFUSAL outranks both: a
                button that will not press has to say that before it says anything about size. A run
                with no company picker on screen is never the bulk case — its size is the scope's,
                and a company count would be describing a control that is not there. */}
            {/* A disabled button says WHY it is disabled, rather than sitting there greyed under a
                label describing an action it will not perform. "Already run" is the fact; the
                callout directly above it is where the way out is written. */}
            {blocked
              ? "Already run — nothing new to compare"
              : priorRun
                ? "Run & compare again"
                : picksCompanies && companyCount >= BULK_THRESHOLD
                  ? `Run & compare across ${allCompanies ? `all ${companyCount}` : companyCount} companies`
                  : "Run & compare"}
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
