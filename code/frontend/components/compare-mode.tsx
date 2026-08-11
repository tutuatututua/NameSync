"use client";

import * as React from "react";
import {
  COMPARE_LANGUAGES,
  COMPARE_TYPES,
  DEFAULT_COMPARE_BY,
  LANGUAGE_LABEL,
  TYPE_LABEL,
  compareByAxes,
  compareByLabel,
  toCompareBy,
  type CompareBy,
} from "@extensions/contract";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * How a run should compare — two controls over one stored value.
 *
 * ── TWO CALLERS: `NewComparisonDialog` AND `ImportReview` ──
 *
 * The import screen's copy was removed on 2026-08-05, when the mode stopped being a per-import
 * choice, and restored on 2026-08-10. The removal was aimed at a real workaround — people were
 * re-uploading a file they had already imported so the import path would open a run with a different
 * mode on it, writing a second complete row set to change one column — and the dialog answers that
 * properly, since it can be pointed at a company, an owner or a past import over data already stored.
 *
 * What the removal also did, unintentionally, was decide which FILES could be imported: the import
 * gate requires a name in the run's language, so a mode fixed at `en_full` refused a Thai-only file
 * outright. That is why the picker is back on that screen and why the pointer to this dialog stayed
 * there beside it — the choice is available at import time, and asking a different question later
 * still costs nothing.
 *
 * Being shared is now load-bearing rather than tidy: two screens configure one column, and a second
 * implementation of these two selects is how they would drift into offering different vocabularies
 * for it. `CompareModeBadge` below is the read-only twin, for the same reason.
 *
 * Two selects rather than one six-item list, because the axes are independent and a flat list of
 * "English · surname", "Thai · full name" … asks the reader to reconstruct the grid in their head
 * to find the cell they want. It is also the shape of the underlying value: `compare_by` is
 * `<language>_<type>`, and a control per axis cannot produce a combination that does not exist.
 *
 * The labels say what they mean and no more — pick English, English names are matched with English
 * names. That is honest rather than loose: the language choice also filters the friend side (see
 * `isScorable`), so a Thai run has only Thai-script names in it. The labels live in the contract
 * next to that filter, so the two cannot drift into disagreeing.
 *
 * There is no "either". It was the default until 2026-07-27 and it scored both contact columns,
 * so a mixed-script file matched in one pass. Removing it means every run excludes one language —
 * a mixed file now takes two runs — which is why `explain()` below says so on every setting rather
 * than only on the unusual ones.
 */
export function CompareModeControl({
  value,
  onChange,
  disabled,
  idPrefix,
}: {
  value: CompareBy;
  onChange: (v: CompareBy) => void;
  disabled?: boolean;
  /** Ids have to be unique on a page that could show this twice. */
  idPrefix: string;
}) {
  const { language, type } = compareByAxes(value);

  return (
    <div className="flex flex-wrap gap-4">
      <div className="min-w-[11rem] flex-1 space-y-1.5">
        <Label htmlFor={`${idPrefix}-part`} className="text-xs">
          Compare
        </Label>
        <Select
          value={type}
          onValueChange={(v) => onChange(toCompareBy(language, v as (typeof COMPARE_TYPES)[number]))}
          disabled={disabled}
        >
          <SelectTrigger id={`${idPrefix}-part`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COMPARE_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {TYPE_LABEL[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="min-w-[9rem] flex-1 space-y-1.5">
        <Label htmlFor={`${idPrefix}-script`} className="text-xs">
          Language
        </Label>
        <Select
          value={language}
          onValueChange={(v) => onChange(toCompareBy(v as (typeof COMPARE_LANGUAGES)[number], type))}
          disabled={disabled}
        >
          <SelectTrigger id={`${idPrefix}-script`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COMPARE_LANGUAGES.map((l) => (
              <SelectItem key={l} value={l}>
                {LANGUAGE_LABEL[l]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <p className="w-full text-xs text-muted-foreground">
        {explain(value)}
      </p>
    </div>
  );
}

/**
 * One line saying what this cell of the matrix does.
 *
 * Kept, but short. The labels carry the ordinary meaning now, so this is only here for the two
 * things a label cannot say and a reader would otherwise discover in the results and mistake for
 * a bug: that a narrowed language leaves the other language's names out of the run entirely, and
 * that a last-name run tries a two-word surname as well as the final word.
 */
function explain(mode: CompareBy): string {
  const { language, type } = compareByAxes(mode);
  const lang = LANGUAGE_LABEL[language];
  const other = language === "th" ? "English" : "Thai";

  const what = type === "full" ? "full names" : `${TYPE_LABEL[type].toLowerCase()}s`;
  const tail =
    type === "surname"
      ? " Where a name has three or more words, the last two are also tried as a surname."
      : "";

  return `Matches ${lang} ${what} against ${lang} names. ${other} names aren't part of this run — they're shown as “Not compared”.${tail}`;
}

/** The mode as it sits on a finished run — small, factual, and never absent. */
export function CompareModeBadge({ mode, className }: { mode: CompareBy; className?: string }) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-normal text-muted-foreground", className)}>
      {compareByLabel(mode)}
      {mode === DEFAULT_COMPARE_BY && <span className="text-2xs opacity-70">default</span>}
    </Badge>
  );
}
