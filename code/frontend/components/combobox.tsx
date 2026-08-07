"use client";

import * as React from "react";
import { Check, ChevronDown, Loader2, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { cn } from "@/lib/utils";

/**
 * A picker that searches on the SERVER — the control this app needs once a table has 100k rows in it.
 *
 * ── What was wrong with what this replaces ──
 *
 * Both pickers it stands in for rendered every option they could ever offer. The roster filter was a
 * `Select` over `data.uploaders`, and `CompanyPicker` a `DropdownMenu` over every company on file.
 * Neither had a cap, a search box or virtualization; both leaned on Radix's built-in typeahead,
 * which is a fine substitute for a filter at forty options and no substitute at all at four
 * thousand — you cannot type "the one in Chonburi" at a typeahead, and typing "b" to reach the
 * eleventh company starting with B is not a search, it is a guess repeated.
 *
 * Worse than the interaction was the payload. Every option had to be on the client before the menu
 * could open, which meant the full list rode along on requests that had nothing to do with it — the
 * owner list shipped inside `GET /network/overview`, on every threshold drag.
 *
 * ── Why this needs no virtualization ──
 *
 * Because it never holds a long list. The server searches and caps (see `OPTION_LIMIT` on the
 * routes); this renders the page it was handed, which is tens of rows, and narrowing is done by
 * typing rather than by scrolling. Virtualizing would have been the fix for keeping the whole list
 * on the client, and keeping the whole list on the client is the thing being removed.
 *
 * THE CAP IS STATED, NEVER SILENT. When the server has more matches than it returned, the footer
 * says so with both numbers. A truncated list that looks complete is worse than no list: it reads
 * as "your company is not on file" when the truth is "your company is not in the first fifty".
 *
 * ── Selection is not submission ──
 *
 * Inherited unchanged from `CompanyPicker`, and it is what makes an unbounded multi-select safe:
 * ticking an option starts nothing. In `multiple` mode the popover stays open across a tick, so
 * picking three is one trip; in single mode it closes, because the answer is complete.
 */

export interface ComboboxOption {
  value: string;
  label: string;
  /** Right-aligned muted text — a roster size or contact count. Never the label's continuation. */
  hint?: string;
}

export function Combobox({
  id,
  options,
  isLoading = false,
  onQueryChange,
  selected,
  onSelect,
  multiple = false,
  triggerLabel,
  triggerMuted = false,
  searchPlaceholder = "Type to search…",
  emptyText = "No matches",
  disabled,
  total,
  header,
  portal = true,
  className,
  contentClassName,
}: {
  id?: string;
  /** The page of options the server returned for the current query. */
  options: ComboboxOption[];
  isLoading?: boolean;
  /** Called with the DEBOUNCED query — the parent turns it into a request. */
  onQueryChange: (q: string) => void;
  /** Ticked values. Single mode passes `[value]` or `[]`; the shape is shared so the tick logic is. */
  selected: readonly string[];
  onSelect: (value: string) => void;
  multiple?: boolean;
  /** What the closed field reads. The parent owns this string — it is the only one that knows
   *  whether an empty selection means "unanswered" or "everyone". */
  triggerLabel: string;
  /** Render the trigger label as a placeholder. Parent-decided for the same reason. */
  triggerMuted?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  /** How many options match the query server-side. Drives the truncation notice; omit if unknown. */
  total?: number;
  /**
   * A pinned row above the results — "Everyone", "All companies". Not an option: it survives
   * filtering, because it is not one of the things being filtered. Typing "sam" must still leave a
   * way back to the unfiltered answer.
   *
   * A render prop rather than a node, so the row can close the popover. Whether it should is the
   * caller's to decide and genuinely differs: picking "Everyone" on a single-select filter is a
   * complete answer and should close, where "All companies" on the multi-select picker sits beside
   * ticks the reader may still be adjusting.
   */
  header?: (close: () => void) => React.ReactNode;
  /**
   * PASS `false` WHENEVER THIS SITS INSIDE A DIALOG. The company picker does.
   *
   * Radix decides "was this click outside me?" by DOM containment. Portalled popover content lives
   * on `document.body`, so it is NOT contained by `DialogContent` — and every click in the picker
   * reads to the dialog as a click outside itself, and dismisses it. Ticking a company closed the
   * whole run you were describing.
   *
   * ── The fix that looked right and was worse ──
   *
   * The obvious repair is `modal` on the popover, because the `DropdownMenu` this replaced is modal
   * by default and had no such bug: a modal layer sets `disableOutsidePointerEvents`, which marks
   * every layer beneath it pointer-events-disabled, so the dialog skips its own outside handler.
   * That reasoning is correct and the cure is still wrong, because Radix saves the pre-modal body
   * style in a MODULE-level variable, guarded on the set of such layers being empty:
   *
   *     if (context.layersWithOutsidePointerEventsDisabled.size === 0) {
   *       originalBodyPointerEvents = ownerDocument.body.style.pointerEvents;
   *       ownerDocument.body.style.pointerEvents = "none";
   *     }
   *
   * A modal popover inside a modal dialog is a second such layer, and unwinding the two corrupts
   * that single saved value: the dialog closed with `pointer-events: none` still on `<body>` and
   * took the entire page down with it — nothing clickable, reload the only way out. Measured, not
   * theorised. It also broke Escape, which dismissed dialog and popover together.
   *
   * So: no modal layer, and no portal when nested. The content renders in place as a descendant of
   * `DialogContent`, containment answers correctly, Escape scopes to the topmost layer on its own,
   * and nothing touches the body's styles. On a page the portal stays on, where it earns its keep
   * escaping ancestor `overflow`.
   */
  portal?: boolean;
  className?: string;
  contentClassName?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [input, setInput] = React.useState("");
  const debounced = useDebouncedValue(input.trim(), 300);
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Derived once so the trigger's `aria-controls`, the input and the listbox cannot drift apart —
  // a combobox whose `aria-controls` names an element that does not exist is worse than none.
  const base = id ?? "combobox";
  const searchId = `${base}-search`;
  const listId = `${base}-list`;

  /**
   * Push the debounced query up, through a ref.
   *
   * Callers pass an inline arrow, whose identity changes every render; listing `onQueryChange` as a
   * dependency would fire this on each one and defeat the debounce it exists to serve. Same argument
   * `NewComparisonDialog` makes for reading its seed through a ref.
   */
  const onQueryChangeRef = React.useRef(onQueryChange);
  onQueryChangeRef.current = onQueryChange;
  React.useEffect(() => {
    onQueryChangeRef.current(debounced);
  }, [debounced]);

  /**
   * A fresh list is a fresh keyboard position: leaving `active` where it was would point the
   * highlight at whatever now happens to sit at index 4 after a search that changed every row.
   *
   * Keyed on the option VALUES, not on the array. Callers build `options` inline
   * (`companies.map(...)`), so the array is a new reference on every render and depending on it ran
   * this after every render — including the one caused by `onMouseEnter` setting `active`. Hovering
   * the fifth row highlighted it and then instantly snapped the highlight back to the first, which
   * made the list look like it was fighting the mouse.
   */
  const optionsKey = options.map((o) => o.value).join(" ");
  React.useEffect(() => setActive(0), [optionsKey]);

  // Reset the box when it closes, so reopening offers the whole list rather than the last search's
  // leftovers. The empty query is almost always already in the query cache, so this costs nothing.
  React.useEffect(() => {
    if (!open) setInput("");
  }, [open]);

  /**
   * Put the caret in the search box on open — the entire reason this is a popover and not a menu.
   *
   * Through a ref on the next frame, not `document.getElementById` inside `onOpenAutoFocus`. That
   * fired before the content was reliably in the document, so the lookup missed and focus stayed on
   * the trigger: the box opened, and typing went nowhere. A ref cannot miss, and one frame is late
   * enough for the mount to have landed.
   */
  React.useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const picked = React.useMemo(() => new Set(selected), [selected]);

  const choose = (value: string) => {
    onSelect(value);
    // Multi stays open — see the header. Single is answered, so it closes.
    if (!multiple) setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (options.length === 0) return;
      const next =
        e.key === "ArrowDown"
          ? Math.min(active + 1, options.length - 1)
          : Math.max(active - 1, 0);
      setActive(next);
      listRef.current?.querySelectorAll("[data-option]")[next]?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const option = options[active];
      if (option) choose(option.value);
    }
  };

  /** More matches than were returned — the honesty line. `total` is server-side, `options` is the page. */
  const truncated = typeof total === "number" && total > options.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          className={cn(
            // The SelectTrigger's own metrics — this lands where Selects and menu-triggers stood,
            // and must not read as a different species of field.
            "flex h-9 w-full min-w-0 items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background",
            "focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            className
          )}
        >
          <span className={cn("line-clamp-1 text-left", triggerMuted && "text-muted-foreground")}>
            {triggerLabel}
          </span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden />
        </button>
      </PopoverTrigger>

      <PopoverContent
        portal={portal}
        /* How an enclosing dialog knows it is covered and should not take the Escape key. The
           marker is the mounted content itself, so it cannot go stale — see `ui/dialog.tsx`. */
        data-combobox-content=""
        className={cn(
          "w-[var(--radix-popover-trigger-width)] min-w-[16rem] p-0",
          contentClassName
        )}
        /* Stop Radix focusing the content itself; the effect above puts the caret in the input on
           the next frame. The two halves are split because only one of them can be timed reliably —
           see that effect. */
        onOpenAutoFocus={(e) => e.preventDefault()}
        /*
          Escape closes the PICKER, not the run being described.

          Radix scopes Escape to its topmost dismissable layer, and nested inside a dialog this
          popover does not reliably win that race — the dialog took the key, dismissed itself, and
          unmounted the picker on the way out, so one keystroke discarded everything typed into the
          form. Closing here and marking the event handled settles it: Radix's own layer handler
          skips dismissal once `defaultPrevented` is set, so whichever layer reads the key second
          leaves the dialog alone.
        */
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          setOpen(false);
        }}
      >
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            id={searchId}
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={searchPlaceholder}
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            autoComplete="off"
          />
          {/* Only while a request is actually in flight. The spinner sits here rather than over the
              list so the rows already on screen stay readable and keep their positions — a list that
              blanks on every keystroke is how a fast search comes to feel slow. */}
          {isLoading && (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
          )}
        </div>

        {header && <div className="border-b p-1">{header(() => setOpen(false))}</div>}

        <div id={listId} ref={listRef} role="listbox" className="max-h-64 overflow-y-auto p-1">
          {options.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {isLoading ? "Searching…" : emptyText}
            </p>
          ) : (
            options.map((o, i) => {
              const isPicked = picked.has(o.value);
              return (
                <button
                  key={o.value}
                  data-option
                  type="button"
                  role="option"
                  aria-selected={isPicked}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(o.value)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none",
                    i === active && "bg-accent text-accent-foreground"
                  )}
                >
                  <Check
                    className={cn("h-4 w-4 shrink-0", !isPicked && "opacity-0")}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate" title={o.label}>
                    {o.label}
                  </span>
                  {o.hint && (
                    <span className="shrink-0 pl-2 tabular-nums text-xs text-muted-foreground">
                      {o.hint}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Never silent about a cap — see the header. */}
        {truncated && (
          <p className="border-t px-3 py-2 text-xs text-muted-foreground">
            Showing {options.length} of {total!.toLocaleString()} — keep typing to narrow.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
