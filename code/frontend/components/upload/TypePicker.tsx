"use client";

import * as React from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUploadSources } from "@/hooks/queries";
import { useAddUploadSource, useRemoveUploadSource } from "@/hooks/mutations";
import { cn } from "@/lib/utils";

/**
 * Where this import's data came from — with a way to add a value that wasn't on the list.
 *
 * A dropdown menu rather than a `<Select>`, because a Select cannot hold a text input: adding
 * inline is the requirement, and "type it, press Add, it is selected and it stays for the next
 * person" has to happen without leaving the import screen. The added value is persisted by its
 * own request, not deferred to the import — abandoning a review is the moment right after
 * somebody has finished typing a new type, and losing it there is the worst possible time.
 *
 * The delete affordance is deliberately quiet (hover only) and shows a use count. Adding freely is
 * only safe if a typo can be taken back, and taking one back is only safe to offer if you can see
 * whether anything is using it first — the count is the whole guard rail, since every entry is
 * deletable, the three the schema starts with included. Removing one is cosmetic anyway: no
 * foreign key points at the value, so imports keep it and the list goes on offering it while
 * any of them do.
 */
export function TypePicker({
  value,
  onChange,
  disabled,
  id,
}: {
  value: string | null;
  onChange: (v: string) => void;
  disabled?: boolean;
  id: string;
}) {
  const sources = useUploadSources();
  const add = useAddUploadSource();
  const remove = useRemoveUploadSource();
  const [draft, setDraft] = React.useState("");
  const [open, setOpen] = React.useState(false);

  const list = sources.data ?? [];
  const selected = list.find((s) => s.value === value);

  async function commitDraft() {
    const v = draft.trim();
    if (!v) return;
    try {
      const created = await add.mutateAsync(v);
      onChange(created.value);
      setDraft("");
      setOpen(false);
    } catch {
      /* the mutation surfaces the error as a toast */
    }
  }

  return (
    <div className="space-y-1.5">
      {/*
        "Type", NOT "Source" — and the distinction is load-bearing enough to be worth the word.

        This field is the PROVENANCE of the file being imported: it is written to `friend.source`
        on every row, permanently, and describes where the data came from. It is not the run's
        `comparison.sources`, which is a per-run choice of which friends to compare and which the
        Find-connections dialog calls "Friend sources".

        Both were briefly called "Source" here, which made a permanent property of the data read as
        a setting on this one comparison. They are different fields with different lifetimes and
        they must not share a label on a screen that could show both.
      */}
      <Label htmlFor={id} className="text-xs">
        Type
      </Label>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            disabled={disabled}
            className="w-full justify-start font-normal"
          >
            {selected?.label ?? (value ? value : <span className="text-muted-foreground">Choose a type…</span>)}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64" align="start">
          {list.map((s) => (
            <DropdownMenuItem
              key={s.value}
              className="group justify-between gap-2"
              onSelect={() => onChange(s.value)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Check className={cn("h-3.5 w-3.5 shrink-0", s.value !== value && "opacity-0")} />
                <span className="truncate">{s.label}</span>
              </span>
              <span
                role="button"
                tabIndex={-1}
                aria-label={`Remove ${s.label}`}
                title={
                  s.useCount > 0
                    ? `Used by ${s.useCount} import${s.useCount === 1 ? "" : "s"} — they keep this type`
                    : "Not used by any import"
                }
                className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus:opacity-100"
                onClick={(e) => {
                  // The menu item's own onSelect would fire and select the value we are deleting.
                  e.preventDefault();
                  e.stopPropagation();
                  remove.mutate(s.value);
                  if (s.value === value) onChange("");
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </span>
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />

          {/* Kept out of the menu's keyboard navigation (`onSelect` prevented) so typing in it
              doesn't jump the highlight between items on every keystroke. */}
          <div className="flex gap-1.5 p-1.5" onKeyDown={(e) => e.stopPropagation()}>
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a type…"
              className="h-8"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commitDraft();
                }
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-8 shrink-0 px-2"
              disabled={!draft.trim() || add.isPending}
              onClick={() => void commitDraft()}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <p className="text-xs text-muted-foreground">
        Where this data came from. New types stay on the list for everyone.
      </p>
    </div>
  );
}
