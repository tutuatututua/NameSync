"use client";

import * as React from "react";
import { GitCompareArrows } from "lucide-react";
import { scopeLabel, type RequestedScope } from "@extensions/contract";
import { Button } from "@/components/ui/button";
import {
  NewComparisonDialog,
  type ComparisonSeed,
} from "@/components/network/NewComparisonDialog";
import { usePermissions } from "@/components/auth-provider";

/**
 * "Compare this" — the button and the dialog behind it, as one thing.
 *
 * Four surfaces need exactly this pair (a company's page, a relationship owner's page, a row on
 * Network → Results, and that tab's own "New comparison" header button), and each of them would
 * otherwise carry the same four lines: an `open` state, a button that sets it, a dialog that reads
 * it, and the permission check that decides whether any of it renders. Four lines is not much; four
 * COPIES of a permission check is the kind of thing that ends up three-quarters applied.
 *
 * There was a fourth — a row on the Uploads table, scoped to the import. It was removed on
 * 2026-08-06: an import row's question is "what became of this file", and a control that spends
 * money and writes a `comparison` was answering a different one from inside the "Runs" column. A
 * re-run of that import is reached from its run's row on Results, scope intact.
 *
 * ── IT RENDERS NOTHING FOR A REVIEWER ──
 *
 * A run WRITES: it opens a `comparison` and fills `comparison_result`. Reviewers read the network,
 * they do not extend it, and the check lives in here rather than at each call site. It is what lets
 * Results be a tab a reviewer can open: the list reads, and every control on it that would write is
 * absent rather than gated at the call site.
 *
 * Since 2026-08-06 this is the ONLY way a run is started — the Network header's "Find connections"
 * button was removed along with the roster picker beside it (see `OverviewTab`), so every run now
 * begins at the thing it is about.
 *
 * ── THE DIALOG IS MOUNTED, NOT NAVIGATED TO ──
 *
 * The scope answers WHICH ROWS and nothing else; the mode and the friend sources are still open
 * questions, and they are the two things somebody pressing this is most likely to want to change
 * (that is the whole point of being able to re-compare rows already on file). So this opens the
 * same dialog the workspace button opens, with whatever axis it can answer already answered.
 */
export function CompareScopeButton({
  scope,
  scopeSelects,
  initial,
  covers,
  label,
  variant = "outline",
  size = "sm",
  className,
}: {
  /**
   * WHICH ROWS — a company, a relationship owner, or a past import.
   *
   * OPTIONAL, and the omitted case is a real one rather than a missing argument: re-running an
   * unscoped comparison asks the same whole-table question, which is exactly the run this dialog
   * builds when nothing is passed. Inventing a scope for it would file the repeat under a narrowing
   * the original never had.
   *
   * Two callers omit it: a re-run of a run that was itself unscoped, and Results' "New comparison"
   * (`canStartRuns` in `RecentRuns`), which is where an unscoped run is now originated. Note that
   * "unscoped" does not mean "whole table by default" — the dialog opens its company and source
   * pickers unanswered, so the reader still says what the run covers before anything is spent.
   */
  scope?: RequestedScope;
  /**
   * WHICH SIDE the scope picked, when the caller knows — the server's answer, passed straight
   * through to the dialog, which uses it to decide whether the friend-source picker is a question
   * worth asking. See `ComparisonListItemSchema`.
   *
   * Optional, and undefined behaves as "keep asking": the two callers that open this WITHOUT a
   * scope have no side to report, and a caller that has a scope but not the side (none today)
   * should get the control rather than lose it silently.
   */
  scopeSelects?: "friends" | "companies" | null;
  /** Controls to arrive PRE-FILLED and still editable — what a re-run carries over from the run it
   *  came from. See `ComparisonSeed`, which is deliberate about what is not seeded. */
  initial?: ComparisonSeed;
  /**
   * What the run would cover, in words, for the button's label and tooltip.
   *
   * Derived from the scope when there is one. Passed in for the unscoped case, where there is
   * nothing to derive it from and "Compare" alone on a row among twenty identical ones tells a
   * screen reader nothing about which row it is on.
   */
  covers?: string;
  /** Overrides the button's text. Omitted, it reads "Compare"; pass null for an icon-only button,
   *  which is what a dense table row wants. */
  label?: string | null;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const { canWrite } = usePermissions();
  if (!canWrite) return null;

  const text = label === undefined ? "Compare" : label;
  // What the run would cover, in the same words the dialog's heading and the run's own chip use.
  // The tooltip carries it even when the face does not, which is what makes an icon-only button in
  // a table of twenty imports distinguishable from its neighbours. Falls back to the whole-table
  // wording, which is what an unscoped run actually covers.
  const what =
    (scope ? scopeLabel(scope.filterBy, scope.filterValue) : covers) ?? covers ?? "every row on file";

  return (
    <>
      <Button
        variant={variant}
        size={text === null ? "icon-sm" : size}
        className={className}
        onClick={() => setOpen(true)}
        aria-label={`Compare ${what}`}
        title={`Run a comparison covering ${what}`}
      >
        <GitCompareArrows className="h-4 w-4" />
        {text}
      </Button>
      {/*
        Mounted only once opened, so twenty rows on the Uploads page are twenty buttons and no
        dialogs. `key` is not needed here the way it is on the Overview tab: each of these owns
        exactly one scope for its whole lifetime, so there is no second scope for stale state to
        leak from.
      */}
      {open && (
        <NewComparisonDialog
          open={open}
          onOpenChange={setOpen}
          scope={scope}
          scopeSelects={scopeSelects}
          initial={initial}
        />
      )}
    </>
  );
}
