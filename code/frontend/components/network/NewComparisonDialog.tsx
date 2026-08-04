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
  sourcesLabel,
  type CompareBy,
} from "@extensions/contract";
import { formatCompanies, formatRelativeTime } from "@/lib/format";
import { useCompanies, useDuplicateRun, useUploadSources } from "@/hooks/queries";
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
};

export function NewComparisonDialog({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fill for a run opened from a finished run or a duplicate import. See `ComparisonSeed`. */
  initial?: ComparisonSeed;
}) {
  const router = useRouter();
  const companies = useCompanies();
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
   * these again" on a specific run, and `seedLine` puts what it carried on the screen. What is
   * still never seeded is the MODE — it is the axis a re-run exists to change, and pre-filling it
   * with the answer you are trying to move away from would be the one field where inheritance is
   * actively unhelpful.
   *
   * `initial` is read through a ref rather than listed as a dependency: callers pass an object
   * literal, whose identity changes on every render, and an effect that setState'd on each of those
   * would never stop.
   */
  const initialRef = React.useRef(initial);
  initialRef.current = initial;

  React.useEffect(() => {
    if (!open) {
      setSelected([]);
      setCompareBy(DEFAULT_COMPARE_BY);
      setSources(null);
      setSeedLine(null);
      return;
    }
    const seed = initialRef.current;
    if (!seed) return;
    const nextCompanies = seed.companies === undefined ? [] : seed.companies;
    const nextSources = seed.sources === undefined ? null : seed.sources;
    setSelected(nextCompanies);
    setSources(nextSources);
    setSeedLine(
      `${nextCompanies === null ? ALL_COMPANIES_LABEL : formatCompanies(nextCompanies, { conjunction: "and" }) ?? ALL_COMPANIES_LABEL} · ${sourcesLabel(nextSources)}`
    );
  }, [open]);

  const hasCompanies = (companies.data?.length ?? 0) > 0;
  /** Every company on file, chosen as a standing answer rather than as a list of names. */
  const allCompanies = selected === null;
  /**
   * How many companies this run covers — the number every warning below is scaled by.
   *
   * For an all-companies run that is the whole list, which is exactly why the bulk warning has to
   * read it from here and not from `selected.length`: "all companies" at a database with 400 of
   * them is the single largest run this dialog can start, and it is the one that would otherwise
   * report a selection size of zero and warn about nothing.
   */
  const companyCount = allCompanies ? (companies.data?.length ?? 0) : selected.length;

  /**
   * Has this exact question been asked before? Advisory — it never blocks the button.
   *
   * Read live as the selection changes, so the answer is already on screen by the time someone
   * reaches for Run rather than arriving after they press it.
   */
  const duplicate = useDuplicateRun(selected, compareBy, sources);
  const priorRun = duplicate.data?.run ?? null;
  const priorCount = duplicate.data?.runCount ?? 0;

  const sourceList = uploadSources.data ?? [];
  const friendCount = friendsInSelection(sources, sourceList);
  const sourceNames = sourcesLabel(
    sources,
    new Map(sourceList.map((s) => [s.value, s.label]))
  );

  async function run() {
    // Null is a real answer (every company); only the unanswered empty list is refused.
    if (selected !== null && selected.length === 0) return;
    try {
      const data = await compareMut.mutateAsync({ companyNames: selected, compareBy, sources });
      onOpenChange(false);
      router.push(`/comparisons/${data.sessionId}`);
    } catch {
      /* the mutation surfaces the error as a toast */
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Find connections</DialogTitle>
          {/* The "one run, not one per company" half of this sentence moved to the
              selection-aware copy below, where it can carry the actual count. Saying it here too
              would state it twice on every selection that already gets the concrete version. */}
          <DialogDescription>
            Match every uploaded person against the companies you pick.
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

        <div className="space-y-1.5">
          <Label htmlFor="new-compare-companies">Companies</Label>
          <CompanyPicker
            id="new-compare-companies"
            companies={companies.data ?? []}
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

        {companyCount >= BULK_THRESHOLD && (
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
              have meaning once there is somebody for them to apply to. */}
          <div className="space-y-1.5">
            <Label htmlFor="new-compare-sources" className="text-xs">
              Whose friends
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

          {/* The same control the import screen carries. This run goes through the internal matcher
              and sends no webhook, so the mode is honoured entirely in-process here — but it must
              mean the same thing on both paths, or two runs labelled "Last name · Thai" would have
              been two different questions. */}
          <CompareModeControl
            idPrefix="new-compare"
            value={compareBy}
            onChange={setCompareBy}
            disabled={compareMut.isPending}
          />
        </div>

        {/*
          "You already ran this" — the same three axes, already answered.

          A callout and not a disabled button. Re-running is frequently correct (friends imported
          since the last one is the obvious case) and nothing here can tell that time from a
          misclick, so this states the fact and leaves the decision where it belongs. The Run
          button relabels itself instead, which is the part that cannot be clicked past unread.

          Rendered only for a run that produced something: a FAILED prior run is excluded server
          side, because pointing at a failure as a reason not to retry is exactly backwards.
        */}
        {priorRun && (
          <Callout tone="warning" title="You have already run this.">
            <p>
              {compareByLabel(compareBy)} · {sourceNames}, against{" "}
              {allCompanies
                ? "every company on file"
                : selected.length === 1
                  ? selected[0]
                  : `these ${selected.length} companies`}{" "}
              —{" "}
              {priorRun.status === "completed"
                ? `${priorRun.matchCount.toLocaleString()} match${priorRun.matchCount === 1 ? "" : "es"} of ${priorRun.scoredCount.toLocaleString()} scored`
                : "still running"}
              , {formatRelativeTime(priorRun.createdAt)}.
              {priorCount > 1 && ` (${priorCount} runs match this exactly.)`}
            </p>
            <p>
              <Link
                href={`/comparisons/${priorRun.id}`}
                className="font-medium underline underline-offset-4"
                onClick={() => onOpenChange(false)}
              >
                Open that run
              </Link>{" "}
              — or run it again, which scores the same friends against the same contacts and adds a
              second set of rows. Worth doing if friends have been imported since.
            </p>
            <p>
              To ask a different question, change the mode or the sources above.
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
          */}
          <LoadingButton
            variant="gradient"
            isLoading={compareMut.isPending}
            /* `[]` is unanswered and blocks; `null` is "every company" and does not. */
            disabled={
              (selected !== null && selected.length === 0) ||
              (sources !== null && friendCount === 0)
            }
            onClick={run}
          >
            <GitCompareArrows className="h-4 w-4" />
            {/* The duplicate wording outranks the bulk wording: both are warnings, and "you are
                about to repeat a run you already have" is the more specific of the two. */}
            {priorRun
              ? "Run again anyway"
              : companyCount >= BULK_THRESHOLD
                ? `Run across ${allCompanies ? `all ${companyCount}` : companyCount} companies`
                : "Find connections"}
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
