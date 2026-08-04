"use client";

import * as React from "react";
import { ChevronDown, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ALL_SOURCES_LABEL, sourcesLabel } from "@extensions/contract";
import { useUploadSources } from "@/hooks/queries";
import { cn } from "@/lib/utils";

/**
 * Which friends to compare — by where they were imported from.
 *
 * Deliberately built to the same spec as `CompanyPicker`, down to the trigger's classes: they sit
 * one above the other in the same dialog, they answer the two halves of the same question ("which
 * companies, against whose friends"), and a reader should not have to work out that two controls
 * that look different are the same kind of control. Read that file's header for the reasoning
 * behind the DropdownMenu base and the absence of a search box — all of it applies here, and this
 * list is shorter, so it applies more easily.
 *
 * ── NOTHING TICKED IS A REAL ANSWER, AND IT IS THE DEFAULT ──
 *
 * This is the one way it departs from CompanyPicker, and the difference runs all the way down to
 * the column. An empty company selection is invalid (the run has nothing to score against and the
 * button stays disabled); an empty source selection means EVERY source, which is both valid and
 * the common case.
 *
 * So the resting label is "All sources" and not a "Select sources…" placeholder. A placeholder
 * would be a lie in the shape of an instruction: it implies an unanswered question and a blocked
 * submit, when in fact the field is answered, the answer is the good one, and most users should
 * leave it alone. It is also why there is no muted styling on the resting state — the field is not
 * empty, it is set.
 *
 * ── THE COUNTS ARE THE POINT ──
 *
 * "LinkedIn (318)" beside "Facebook (1,204)" is what makes narrowing a decision rather than a
 * guess. `friendCount` counts PEOPLE, not imports — see `UploadSourceSchema` for why the
 * pick-list's other count (`useCount`) would be the wrong number on this screen.
 *
 * A source with no friends is shown and disabled, not hidden. Hiding it makes an entry somebody
 * added and never imported under look like it was never added; disabling it with a zero explains
 * both why it cannot be picked and what to do about it.
 */
export function SourcePicker({
  selected,
  onChange,
  disabled,
  id,
}: {
  /** Null is every source — the resting state, not an empty one. */
  selected: string[] | null;
  onChange: (next: string[] | null) => void;
  disabled?: boolean;
  id?: string;
}) {
  const sources = useUploadSources();
  const list = React.useMemo(() => sources.data ?? [], [sources.data]);

  /** Only sources with friends behind them can be compared; the rest render disabled. */
  const selectable = React.useMemo(() => list.filter((s) => s.friendCount > 0), [list]);

  const picked = React.useMemo(() => new Set(selected ?? []), [selected]);

  const labels = React.useMemo(
    () => new Map(list.map((s) => [s.value, s.label])),
    [list]
  );

  const totalFriends = React.useMemo(
    () => list.reduce((n, s) => n + s.friendCount, 0),
    [list]
  );

  /**
   * Toggling rebuilds from the list rather than from click order, exactly as CompanyPicker does —
   * and here it is what keeps the value canonical, since the server sorts on the way in and the
   * duplicate check compares arrays element-wise.
   *
   * Emptying the selection emits NULL, not []. They mean opposite things (`every source` vs `no
   * source`), the API rejects one of them, and unticking the last box is far more likely to mean
   * "actually, all of them" than "compare nobody".
   */
  const toggle = (value: string) => {
    const next = new Set(picked);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    const list_ = selectable.filter((s) => next.has(s.value)).map((s) => s.value);
    onChange(list_.length === 0 ? null : list_);
  };

  const label = sourcesLabel(selected, labels);

  /** The number under the field: what this selection actually puts in the run. */
  const inRun = selected === null
    ? totalFriends
    : selectable.filter((s) => picked.has(s.value)).reduce((n, s) => n + s.friendCount, 0);

  return (
    <div className="flex min-w-0 items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled || selectable.length === 0}>
          <button
            id={id}
            type="button"
            className={cn(
              // The SelectTrigger's own classes, matched to CompanyPicker directly above it.
              "flex h-9 w-full min-w-0 items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background",
              "focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            {/* Never muted: "All sources" is a set value, not a placeholder. */}
            <span className="line-clamp-1 text-left">{label}</span>
            <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="start"
          className="max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] w-[var(--radix-dropdown-menu-trigger-width)] min-w-[14rem]"
        >
          {/* The way back to the default, and the only control that can set it: unticking the last
              box does the same thing, but a reader who has ticked three needs one click, and needs
              to be told that "all" is where they started. */}
          <DropdownMenuItem
            inset
            onSelect={(e) => e.preventDefault()}
            onClick={() => onChange(null)}
            className={cn("font-medium", selected === null && "text-muted-foreground")}
          >
            {ALL_SOURCES_LABEL}
            <span className="ml-auto pl-3 tabular-nums text-xs text-muted-foreground">
              {totalFriends.toLocaleString()}
            </span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />

          {list.map((s) => {
            const empty = s.friendCount === 0;
            return (
              <DropdownMenuCheckboxItem
                key={s.value}
                checked={picked.has(s.value)}
                disabled={empty}
                /* Keeps the menu open across a tick — picking two sources should not mean opening
                   the menu twice. Same reasoning as CompanyPicker. */
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={() => toggle(s.value)}
                title={
                  empty
                    ? `No friends have been imported from ${s.label} yet`
                    : `${s.friendCount.toLocaleString()} friend${s.friendCount === 1 ? "" : "s"}`
                }
              >
                <span className="flex w-full min-w-0 items-center justify-between gap-3">
                  <span className="truncate">{s.label}</span>
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                    {s.friendCount.toLocaleString()}
                  </span>
                </span>
              </DropdownMenuCheckboxItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Only when something is ticked — the resting state has nothing to clear, and an always-on
          X beside "All sources" would suggest that clearing it does something. */}
      {selected !== null && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => onChange(null)}
          aria-label="Compare against all sources"
          title="Back to all sources"
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </Button>
      )}

      <span className="sr-only" aria-live="polite">
        {inRun.toLocaleString()} friends in this run
      </span>
    </div>
  );
}

/**
 * How many friends a source selection puts in a run — for the copy under the picker.
 *
 * Exported because the dialog states it in prose ("Comparing 318 LinkedIn friends against 3
 * companies") and the picker states it to screen readers, and the two must not be able to
 * disagree about a number the user is deciding on.
 */
export function friendsInSelection(
  selected: string[] | null,
  list: { value: string; friendCount: number }[]
): number {
  if (selected === null) return list.reduce((n, s) => n + s.friendCount, 0);
  const picked = new Set(selected);
  return list.filter((s) => picked.has(s.value)).reduce((n, s) => n + s.friendCount, 0);
}
