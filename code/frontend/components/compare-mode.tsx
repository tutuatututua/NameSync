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
 * ── ONE CALLER, SINCE 2026-08-05 ──
 *
 * `NewComparisonDialog`. The import screen carried a second copy until the mode stopped being a
 * per-import choice (every import is `en_full`), and what looked like the loss of a control was the
 * removal of a workaround: people were re-uploading a file they had already imported so that the
 * import path would open a run with a different mode on it, which wrote a second complete row set
 * to change one column. The dialog can now be pointed at a company, a relationship owner or a past
 * import directly, so the choice is available over data already on file and costs nothing to make.
 *
 * It stays a shared component rather than folding into its one caller: `CompareModeBadge` below is
 * the read-only twin and has several, and keeping the picker beside the badge is what stops the
 * control and the chip from drifting into describing the same value differently.
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
