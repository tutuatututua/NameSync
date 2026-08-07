"use client"

import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"

import { cn } from "@/lib/utils"

/**
 * A popover — the primitive `DropdownMenu` could not be, and the reason `Combobox` exists.
 *
 * `company-picker.tsx` argued at length for why a filter input cannot live inside a Radix *menu*:
 * a menu focuses its first item on open, keeps `onOpenAutoFocus` private (it is stripped from
 * `MenuRootContentTypeProps`), and runs its own typeahead on the content root, which eats the
 * keystrokes an input wants. All three are true, and all three are properties of MENUS specifically.
 *
 * A popover is not a menu. It has no roving focus, no typeahead, and `onOpenAutoFocus` is part of
 * its public surface — so an input inside one keeps the caret without a single `stopPropagation`.
 * It still brings the three things that were genuinely hard to hand-roll and were the real reason
 * the picker was built on a menu at all: a portal that escapes the card's overflow, dismiss on
 * outside-click and Escape, and focus containment.
 *
 * This file is the unopinionated wrapper only. The searchable list, its debounce and its keyboard
 * model live in `components/combobox.tsx`.
 */

const Popover = PopoverPrimitive.Root

const PopoverTrigger = PopoverPrimitive.Trigger

const PopoverAnchor = PopoverPrimitive.Anchor

/**
 * `portal` — where the content is MOUNTED, and inside a dialog it decides whether the dialog lives.
 *
 * Portalling to `document.body` is right on a page: it escapes any ancestor's `overflow`. Inside a
 * `Dialog` it is actively wrong, because Radix decides "was this click outside me?" by DOM
 * containment. Portalled content is not contained by `DialogContent`, so every click in the popover
 * reads as a click outside the dialog and dismisses it.
 *
 * Set `portal={false}` inside a dialog. The content then renders in place, as a descendant of
 * `DialogContent`, and the containment check passes. `DialogContent` sets no `overflow`, so there is
 * nothing to escape and nothing is lost by staying put.
 *
 * The tempting fix is `modal` on the popover instead, and it is a trap — see `combobox.tsx`.
 */
const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & { portal?: boolean }
>(({ className, align = "start", sideOffset = 4, portal = true, ...props }, ref) => {
  const Wrapper = portal ? PopoverPrimitive.Portal : React.Fragment;
  return (
  <Wrapper>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        // Deliberately the same shell as DropdownMenuContent — this replaces one in-place under two
        // existing fields, and a picker that swapped species mid-refactor would read as a different
        // control rather than as the same control that learned to search.
        "z-50 rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-popover-content-transform-origin]",
        className
      )}
      {...props}
    />
  </Wrapper>
  );
})
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent }
