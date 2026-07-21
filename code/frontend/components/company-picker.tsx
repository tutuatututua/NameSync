"use client";

import * as React from "react";
import { Check, ChevronDown, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
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
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  id?: string;
  placeholder?: string;
}) {
  // A Set for the ticks: the list renders per company and `includes` over an array would make
  // drawing a long list quadratic in the number selected.
  const picked = React.useMemo(() => new Set(selected), [selected]);

  /**
   * Toggling preserves the *picker's* order, not the click order.
   *
   * The list is what names the run, and a run named "BANPU, PTT" when you ticked PTT first reads as
   * though something reordered your answer. Rebuilding from `companies` means the name always
   * matches the order on screen — and it is also what the API's tie-break assumes (of two equally
   * good matches the earlier company wins), so the two agree by construction rather than by luck.
   */
  const toggle = (company: string) => {
    const next = new Set(picked);
    if (next.has(company)) next.delete(company);
    else next.add(company);
    onChange(companies.filter((c) => next.has(c)));
  };

  /**
   * One name, or a count — never a truncated list of names.
   *
   * "PTT, BANGKOK BANK, BLUEB…" in a 9rem field is worse than "3 companies": it commits the space
   * to the two names you can already see in the open menu, and then lies about the third by cutting
   * it. The count is the fact the trigger is actually able to carry at this size, and the menu
   * beneath it holds the detail.
   */
  const label =
    selected.length === 0
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
            <span
              className={cn(
                "line-clamp-1 text-left",
                selected.length === 0 && "text-muted-foreground"
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
          too. It earns its place at three companies, where undoing by hand is three trips. */}
      {selected.length > 0 && (
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
