"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/combobox";
import { ALL_COMPANIES_LABEL } from "@extensions/contract";
import { cn } from "@/lib/utils";

/**
 * Pick the companies to compare against — one, or several.
 *
 * ── Why this is a combobox now (2026-08-04) ──
 *
 * It was a `DropdownMenu` over every company on file, and it carried a long, honest note explaining
 * why it had NO SEARCH BOX: Radix focuses the first item of a menu on open, keeps `onOpenAutoFocus`
 * private on `MenuRootContentTypeProps`, and runs its own typeahead on the content root, all of
 * which an input inside it has to fight. Every word of that was true. The note also named its own
 * expiry date — "if the company list ever grows past what typeahead and a scroll can carry, the
 * honest fix is a real combobox primitive, not a text input smuggled into a menu" — and at 100k
 * rows that is where the list is.
 *
 * So this is the fix it asked for rather than the one it refused. The search box is not smuggled
 * into a menu; the menu is gone. `components/ui/popover.tsx` has no roving focus and no typeahead
 * and exposes `onOpenAutoFocus`, so the caret stays in the input without a single
 * `stopPropagation`, and `components/combobox.tsx` does the searching against the server.
 *
 * The parity argument the old note closed with survives intact, pointed the other way: typing "ban"
 * still reaches BANGKOK BANK. It now also reaches the eleventh company starting with B, which
 * typeahead never could.
 *
 * SELECTION IS NOT SUBMISSION. Ticking a company does not start anything; the Run button does.
 * That is what makes an unbounded multi-select safe here — a mis-tick costs a second tick, not a
 * run over the wrong data. It is also why the popover stays open across a tick.
 *
 * ── THREE STATES, AND WHY THIS ONE PICKER NEEDS ALL THREE ──
 *
 * Unchanged by the rebuild, and the reason this file still exists rather than the dialog calling
 * `Combobox` directly. `SourcePicker` has two (`null` = every source, a list = those sources), and
 * the reason it can is that its field is answered the moment the dialog opens: "all friends" is the
 * right run. This field is not. So:
 *
 *   · `[]`      — UNANSWERED. Placeholder, and the dialog's button stays disabled.
 *   · `null`    — every company, chosen deliberately from the pinned row.
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
 * is what lets the duplicate check see two all-company runs as the same question. It is now also
 * the only shape that COULD express this, since the client no longer holds every name to list.
 */
export function CompanyPicker({
  companies,
  total,
  isLoading,
  onQueryChange,
  selected,
  onChange,
  disabled,
  id,
  placeholder = "Select companies…",
}: {
  /** The page of companies the server returned for the current search — never the whole list. */
  companies: string[];
  /** How many companies match the search in total. Drives the pinned row's count. */
  total: number;
  isLoading?: boolean;
  onQueryChange: (q: string) => void;
  /** `[]` unanswered · `null` every company · a list, those companies. See the header. */
  selected: string[] | null;
  onChange: (next: string[] | null) => void;
  disabled?: boolean;
  id?: string;
  placeholder?: string;
}) {
  const all = selected === null;

  /**
   * Toggling preserves the order the user built, not the picker's.
   *
   * This is the one behaviour the rebuild had to change, and it is worth stating why. The old
   * version rebuilt the selection as `companies.filter(c => next.has(c))` — the picker's own
   * alphabetical order — which was exact while `companies` held every company. It cannot be now:
   * the array is a SEARCH RESULT, so filtering through it would silently drop every already-picked
   * company that the current search does not happen to return. Ticking PTT, typing "bang", then
   * ticking BANGKOK BANK would have discarded PTT.
   *
   * So selection order it is, which is stable under a changing options list and is the only order
   * the client can still know. The API's tie-break (of two equally good matches the earlier company
   * wins) reads `company_names` as sent, so the run's tie-break now follows the order the user
   * built rather than the alphabet — a different rule, still a predictable one, and still exactly
   * the order the trigger and the dialog's summary name it in.
   */
  const toggle = (company: string) => {
    // Ticking out of "All companies" starts a NAMED selection from that one company, rather than
    // from all 412 minus none. "All" is not a set here, it is a different answer — see the header —
    // so there is nothing for the first tick to subtract from.
    const base = all ? [] : (selected ?? []);
    onChange(base.includes(company) ? base.filter((c) => c !== company) : [...base, company]);
  };

  /**
   * One name, or a count — never a truncated list of names.
   *
   * "PTT, BANGKOK BANK, BLUEB…" in a 9rem field is worse than "3 companies": it commits the space
   * to the two names you can already see in the open list, and then lies about the third by cutting
   * it. The count is the fact the trigger is actually able to carry at this size.
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
      <Combobox
        id={id}
        multiple
        /* This picker's only home is `NewComparisonDialog`, and a portalled popover inside a dialog
           makes every tick read as a click outside it — the dialog dismissed itself and took the
           run with it. Rendering in place keeps the content a descendant of `DialogContent`, which
           is the containment Radix actually tests. See `Combobox`'s `portal` for the whole story,
           including why the modal-layer fix that looks right froze the entire page. */
        portal={false}
        options={companies.map((c) => ({ value: c, label: c }))}
        total={total}
        isLoading={isLoading}
        onQueryChange={onQueryChange}
        selected={all ? [] : (selected ?? [])}
        onSelect={toggle}
        disabled={disabled}
        triggerLabel={label}
        /* Muted only while UNANSWERED. "All companies" is a set value and is styled like one — the
           same argument SourcePicker makes for its own resting label. */
        triggerMuted={!all && selected.length === 0}
        searchPlaceholder="Search companies…"
        emptyText="No companies match"
        /*
          The way to say "every company", and the only control that sets it. Pinned above the
          results, so it survives a search — see `Combobox`'s `header`.

          It does NOT close the popover, unlike the roster filter's "Everyone": this is a
          multi-select and the reader may be mid-adjustment. Nothing is ticked underneath it either,
          because the individual boxes answer "which ones" and that question is not being asked when
          the answer is "all of them" — ticking all 412 to represent it would also make unticking one
          read as "all except this", which is not a run this can express.

          The count is `total`, the server's, never `companies.length`: this row's whole job is to
          say how big "everything" is, and the array beside it is one capped page of it.
        */
        header={() => (
          <button
            type="button"
            onClick={() => onChange(null)}
            className={cn(
              "flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm font-medium hover:bg-accent hover:text-accent-foreground",
              all && "text-muted-foreground"
            )}
          >
            {ALL_COMPANIES_LABEL}
            <span className="ml-auto pl-3 tabular-nums text-xs text-muted-foreground">
              {total.toLocaleString()}
            </span>
          </button>
        )}
      />

      {/* Only once there is something to clear, and never as the only way out — unticking works
          too. It earns its place at three companies, where undoing by hand is three trips, and it
          earns it more now that the three may be spread across three different searches.

          Absent under "All companies", which is a chosen answer and not a selection: an X beside it
          would suggest clearing does something, and what it would actually do is un-answer the
          field and disable the button. The pinned row is how you get back. */}
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
