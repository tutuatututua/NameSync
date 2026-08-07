"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/80  data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

/**
 * Escape must close the INNERMOST thing, and Radix cannot work that out on its own here.
 *
 * Its `DismissableLayer` scopes Escape to the topmost layer — but "topmost" is computed during
 * render from a plain mutable `Set`, with nothing to subscribe to. A popover opening inside this
 * dialog mutates that set without re-rendering the dialog, so the dialog never learns it has been
 * covered and keeps the document listener it registered when it *was* topmost. Its listener was
 * registered first, so it runs first, and one Escape dismissed the dialog and unmounted the picker
 * on the way out — discarding a half-described run because someone backed out of a search box.
 *
 * So the dialog declines the key whenever a combobox is open above it, and lets that combobox's own
 * handler (which runs immediately after) do the closing. Scoped to a live DOM query rather than a
 * flag, because the layer that matters is the one that is actually mounted right now — and the
 * check is cheap, running once per Escape rather than per render.
 */
const OPEN_COMBOBOX = "[data-combobox-content]"

/**
 * A click aimed at a COVERED dialog is not a click on the backdrop — and Radix cannot tell.
 *
 * Open a modal layer inside this dialog (the friend-sources `DropdownMenu`, either `Select`) and
 * three things happen at once: the layer sets `pointer-events: none` on `<body>`, Radix sets it on
 * `DialogContent` too (every layer below the topmost modal one is marked non-interactive), and
 * `DialogOverlay` keeps the `pointerEvents: "auto"` Radix hard-codes on it. The overlay is
 * full-viewport and sits under the content, so with the content switched off it becomes the hit
 * target for EVERY POINT OVER THE DIALOG — the title, the fields, Cancel, Run.
 *
 * The overlay is also registered as the dialog's `dismissableSurface`, which is exactly right when
 * it is the visible backdrop and exactly wrong here. So one click over the middle of the dialog
 * dispatched `pointerDownOutside` twice — once for the menu, which closed it, and once for the
 * dialog, which dismissed it. The friend-sources menu deliberately stays open across a tick (see
 * `SourcePicker`), so a user who picked a source was ALWAYS left in this state, and the next click
 * anywhere threw away the run they were describing. Measured, not theorised: the whole dialog
 * vanished on the click after a source was ticked.
 *
 * The rule this restores is the ordinary one for stacked layers: while something is open above
 * this dialog, that something owns the click. It closes; the dialog stays; a second click can then
 * dismiss the dialog, which is what a reader who genuinely meant the backdrop will do anyway.
 *
 * ── Why this is geometry and not "is something open?" ──
 *
 * The obvious test is the state that causes it: ask whether a higher modal layer is covering us,
 * which Radix already answers in the content's own computed `pointer-events` (`none` exactly when
 * one is). That test is correct and it does not work, because by the time this handler runs the
 * answer has changed. ONE pointerdown dispatches `pointerDownOutside` to every layer, the menu's
 * turn comes first, and closing it re-renders the dialog back to `pointer-events: auto` before the
 * dialog's own turn — the guard reads "nothing is covering me" and the dialog dies anyway. Radix
 * emits its own `dismissableLayer.update` between the two dispatches; that is this happening.
 *
 * So test the thing that cannot change mid-dispatch: WHERE the pointer was. A click whose
 * coordinates land inside this dialog's own box is not a click on the backdrop, whatever the DOM
 * says the target was — and when nothing is covering us the question never arises, because such a
 * click is contained by the content and never becomes an outside event at all.
 *
 * Pointer events only. The focus path carries no coordinates, and a modal dialog already refuses
 * `onFocusOutside` in Radix itself.
 */
const isPointerWithin = (content: HTMLElement | null, event: Event): boolean => {
  if (!content || !("clientX" in event)) return false
  const { clientX: x, clientY: y } = event as PointerEvent
  const box = content.getBoundingClientRect()
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, onEscapeKeyDown, onInteractOutside, ...props }, ref) => {
  // Own ref, composed with the forwarded one: the guard above has to read the mounted node's
  // computed style, and callers must still get whatever ref they passed.
  const contentRef = React.useRef<HTMLDivElement>(null)
  const composedRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node
      if (typeof ref === "function") ref(node)
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node
    },
    [ref]
  )

  return (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={composedRef}
      onEscapeKeyDown={(event) => {
        onEscapeKeyDown?.(event)
        if (!event.defaultPrevented && document.querySelector(OPEN_COMBOBOX)) {
          event.preventDefault()
        }
      }}
      /* Covers both halves of "interact outside" — the pointer path and the focus path — because
         Radix checks `defaultPrevented` once, after calling both. See `isCoveredByHigherLayer`. */
      onInteractOutside={(event) => {
        onInteractOutside?.(event)
        if (!event.defaultPrevented && isPointerWithin(contentRef.current, event.detail.originalEvent)) {
          event.preventDefault()
        }
      }}
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
        className
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
