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
import { ALL_COMPANIES_LABEL } from "@extensions/contract";
import { cn } from "@/lib/utils";

/**
 * Pick the companies to compare against — one, or several.
 *
 * This replaced a plain `Select`, and the shape of the control is the argument for the change: a
 * radio list says "which one of these", and the question is now "which of these". The trigger keeps
 * the Select's exact metrics and border so it still reads as the same field in the same form; what
 * changed is what it can hold.
 *
 * Built on `DropdownMenu`, which already does the three things this needs and which are genuinely
 * hard to retrofit: a portal that escapes the card's overflow, dismiss-on-outside-click, and
 * keyboard navigation with type-to-jump. What it does NOT do is stay open across a selection —
 * hence the `preventDefault` below, which is the one behaviour we have to take back from it.
 *
 * NO SEARCH BOX, deliberately. A filter input inside a menu cannot reliably hold the caret: Radix
 * focuses the first item on open and keeps `onOpenAutoFocus` private on menus specifically (it is
 * stripped in `MenuRootContentTypeProps`), because a menu is not a combobox. It also runs its own
 * typeahead on the content root, which eats the keystrokes an input would want. Both are fightable
 * with effects and `stopPropagation`, and both fights are lost on the next Radix minor.
 *
 * The parity argument settles it: the `Select` this replaced had no filter either — both it and
 * this rely on Radix's built-in typeahead, so typing "ban" still jumps to BANGKOK BANK exactly as
 * it did before. Nobody loses a filter they had. If the company list ever grows past what typeahead
 * and a scroll can carry, the honest fix is a real combobox primitive, not a text input smuggled
 * into a menu.
 *
 * SELECTION IS NOT SUBMISSION. Ticking a company does not start anything; the Compare button does.
 * That is what makes an unbounded multi-select safe here — a mis-tick costs a second tick, not a
 * run over the wrong data.
 *
 * ── THREE STATES, AND WHY THIS ONE PICKER NEEDS ALL THREE ──
 *
 * `SourcePicker` has two (`null` = every source, a list = those sources), and the reason it can is
 * that its field is answered the moment the dialog opens: "all friends" is the right run. This
 * field is not. So:
 *
 *   · `[]`      — UNANSWERED. Placeholder, and the dialog's button stays disabled.
 *   · `null`    — every company, chosen deliberately from the menu's first item.
 *   · `[...]`   — exactly these.
 *
 * The empty array carrying "unanswered" is the one place this departs from the codebase's usual
 * empty-collapses-to-null rule, and it is deliberate: that rule exists to stop two shapes of the
 * same answer reaching the database, and this shape never gets that far — the dialog refuses to
 * submit it. What would be genuinely dangerous is the inverse, defaulting an untouched field to
 * "every company on file" and letting one click run it.
 *
 * `null` and not a materialised list of every name, which is what "Select all" used to emit. A
 * stored list is a SNAPSHOT: a run named for the 412 companies on file today still says 412 after
 * tomorrow's import, so a re-run of "everything" quietly stops meaning it. NULL is the standing
 * answer, it is what `comparison.selected_companies` has always used for a whole-table run, and it
 * is what lets the duplicate check see two all-company runs as the same question.
 */
export function CompanyPicker({
  companies,
  selected,
  onChange,
  disabled,
  id,
  placeholder = "Select companies…",
}: {
  companies: string[];
  /** `[]` unanswered · `null` every company · a list, those companies. See the header. */
  selected: string[] | null;
  onChange: (next: string[] | null) => void;
  disabled?: boolean;
  id?: string;
  placeholder?: string;
}) {
  // A Set for the ticks: the list renders per company and `includes` over an array would make
  // drawing a long list quadratic in the number selected.
  //
  // Nothing is ticked under "All companies". The individual boxes answer "which ones", and that
  // question is not being asked when the answer is "all of them" — ticking all 412 to represent it
  // would also make unticking one read as "all except this", which is not a run this can express.
  const picked = React.useMemo(() => new Set(selected ?? []), [selected]);
  const all = selected === null;

  /**
   * Toggling preserves the *picker's* order, not the click order.
   *
   * The list is what names the run, and a run named "BANPU, PTT" when you ticked PTT first reads as
   * though something reordered your answer. Rebuilding from `companies` means the name always
   * matches the order on screen — and it is also what the API's tie-break assumes (of two equally
   * good matches the earlier company wins), so the two agree by construction rather than by luck.
   */
  /**
   * Ticking a box out of "All companies" starts a NAMED selection from that one company, rather
   * than from all 412 minus none. "All" is not a set here, it is a different answer — see the
   * header — so there is nothing for the first tick to subtract from.
   */
  const toggle = (company: string) => {
    const next = new Set(all ? [] : picked);
    if (next.has(company)) next.delete(company);
    else next.add(company);
    onChange(companies.filter((c) => next.has(c)));
  };

  /**
   * The way to say "every company", and the only control that sets it.
   *
   * It shipped as "Select all N", which ticked every box and emitted the whole list — so "re-run
   * across everything" was expressible, but only as a snapshot of the names on file at that moment
   * (see the header for why that decays). It emits NULL now, which is the same answer without the
   * expiry date, and which `POST /comparisons/compare` has accepted since 2026-08-04.
   *
   * The count rides in the trailing slot rather than the label, exactly as SourcePicker's does:
   * this menu is unbounded by design and the size of "all" should land before the click, but it is
   * a fact about the choice, not part of its name.
   */
  const chooseAll = () => onChange(null);

  /**
   * One name, or a count — never a truncated list of names.
   *
   * "PTT, BANGKOK BANK, BLUEB…" in a 9rem field is worse than "3 companies": it commits the space
   * to the two names you can already see in the open menu, and then lies about the third by cutting
   * it. The count is the fact the trigger is actually able to carry at this size, and the menu
   * beneath it holds the detail.
   */
  const label = all
    ? ALL_COMPANIES_LABEL
    : selected.length === 0
      ? placeholder
      : selected.length === 1
        ? selected[0]
        : `${selected.length} companies`;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled || companies.length === 0}>
          <button
            id={id}
            type="button"
            className={cn(
              // Deliberately the SelectTrigger's own classes — this sits where a Select used to and
              // must not read as a different species of field.
              "flex h-9 w-full min-w-0 items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background",
              "focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            {/* Muted only while UNANSWERED. "All companies" is a set value and is styled like
                one — the same argument SourcePicker makes for its own resting label. */}
            <span
              className={cn(
                "line-clamp-1 text-left",
                !all && selected.length === 0 && "text-muted-foreground"
              )}
            >
              {label}
            </span>
            <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="start"
          /* Matches the trigger's width so the menu reads as the field opening rather than as a
             separate panel, but with a floor — the trigger can be narrow on a phone and a 6rem
             menu would truncate every company in it. */
          className="max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] w-[var(--radix-dropdown-menu-trigger-width)] min-w-[14rem]"
        >
          {/* Inside the menu, not beside the trigger: that row already carries the field plus the
              clear-X and gets tight on a phone. `inset` puts it on the checkbox items' own `pl-8`,
              so it aligns with the list it acts on instead of hanging off its left edge. */}
          <DropdownMenuItem
            inset
            onSelect={(e) => e.preventDefault()}
            onClick={chooseAll}
            className={cn("font-medium", all && "text-muted-foreground")}
          >
            {ALL_COMPANIES_LABEL}
            <span className="ml-auto pl-3 tabular-nums text-xs text-muted-foreground">
              {companies.length.toLocaleString()}
            </span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />

          {companies.map((c) => (
            <DropdownMenuCheckboxItem
              key={c}
              checked={picked.has(c)}
              /* Keeps the menu open across a tick. Without this it closes on the first company,
                 which turns picking three into opening the menu three times — i.e. back to the
                 single Select this replaced, only slower. */
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={() => toggle(c)}
            >
              <span className="truncate" title={c}>
                {c}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Only once there is something to clear, and never as the only way out — unticking works
          too. It earns its place at three companies, where undoing by hand is three trips.

          Absent under "All companies", which is a chosen answer and not a selection: an X beside it
          would suggest clearing does something, and what it would actually do is un-answer the
          field and disable the button. The menu's first item is how you get back. */}
      {!all && selected.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => onChange([])}
          aria-label="Clear selected companies"
          title="Clear selection"
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
