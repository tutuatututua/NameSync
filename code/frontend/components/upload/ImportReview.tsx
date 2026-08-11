"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  FileText,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  compareByAxes,
  DEFAULT_COMPARE_BY,
  LANGUAGE_LABEL,
  precheckBlocks,
  sourceLabel,
  TYPE_LABEL,
  type ColumnMapping,
  type ColumnOverrides,
  type CompareBy,
  type ImportPrecheck,
  type UploadPreview,
} from "@extensions/contract";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
} from "@/components/ui/select";
import { LoadingButton } from "@/components/loading-button";
import { Callout } from "@/components/callout";
import { CompareModeControl } from "@/components/compare-mode";
import { TypePicker } from "@/components/upload/TypePicker";
import { useAuth } from "@/components/auth-provider";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { usePreviewUpload } from "@/hooks/mutations";
import { useRunComparison } from "@/hooks/mutations";

/**
 * Step two of an import: show what the file actually contains, then commit it.
 *
 * The preview is produced by the server running the file through the *same* reader the
 * import uses, so the columns and rows shown here are the ones that will land. Nothing has
 * been written at this point — the file was parsed and thrown away.
 *
 * That does mean the file is uploaded twice: once to preview, once to import. The
 * alternative is parking half-finished uploads on disk with a TTL and a reaper, which is a
 * lot of machinery for files this size.
 */

export type ImportSource = "company" | "facebook";

interface Props {
  source: ImportSource;
  file: File;
  /** Back to the file picker. */
  onCancel: () => void;
  /** The import landed. */
  onComplete?: () => void;
}

const fieldName = (source: ImportSource) => (source === "company" ? "companyFile" : "facebookFile");

/** "No columns mapped by hand". One shared object, so resetting to it is a no-op React can see —
 *  a fresh `{}` would be a new value every time and re-fire the preview it is a dependency of. */
const NO_OVERRIDES: ColumnOverrides = {};

/** The one target column that can be filled from OUTSIDE the file — see `OwnerNote`. */
const OWNER_TARGET = "relationship_owner";

/**
 * One sample cell.
 *
 * A name column shows the *cleaned* name — the value that will be stored, matched and displayed —
 * with the file's original underneath whenever cleaning changed it. This is now the only place
 * the two are ever visible together: the raw text is not written to the database, so a rule that
 * mangles a name has to be caught on this screen or not at all.
 */
const renderCell = (m: ColumnMapping, row: Record<string, string | null>) => {
  const value = row[m.target] ?? null;
  if (value === null || value === "") return <span className="text-muted-foreground">—</span>;
  if (!m.cleaned) return <span className="block max-w-[18rem] truncate" title={value}>{value}</span>;

  const clean = row[`${m.target}_clean`] ?? null;

  // Cleaned away to nothing — the cell held only a title ("Mr", "คุณ") with no name behind it.
  // This row will not be imported, and saying so is the entire job of this screen. It used to
  // fall back to rendering the raw value here, which claimed the opposite: that the name was
  // kept, unchanged, when in fact the row was about to be dropped.
  if (clean === null) {
    return (
      <div className="max-w-[18rem]">
        <span className="block text-xs font-medium text-destructive">Not imported</span>
        <span className="block truncate text-xs text-muted-foreground line-through" title={value}>
          {value}
        </span>
      </div>
    );
  }

  return (
    <div className="max-w-[18rem]">
      <span className="block truncate" title={clean}>
        {clean}
      </span>
      {clean !== value && (
        <span className="block truncate text-xs text-muted-foreground line-through" title={value}>
          {value}
        </span>
      )}
    </div>
  );
};

export function ImportReview({ source, file, onCancel, onComplete }: Props) {
  const isCompany = source === "company";
  const router = useRouter();
  const { user } = useAuth();
  const [owner, setOwner] = React.useState("");
  /**
   * Who performed the import — prefilled from the session, and editable.
   *
   * Prefilled because the signed-in user is the person standing there, and asking them to type
   * their own name every time is the kind of field people fill with "a". Editable because a
   * shared or kiosk account exists, and because `AUTH_DISABLED` is a supported mode where there
   * is no session to read.
   *
   * Note this is NOT the assistant case that split uploader from owner. There the assistant IS
   * the uploader and this default is right; what they change is the relationship owner below.
   */
  const [uploader, setUploader] = React.useState(user?.name ?? user?.email ?? "");
  /** Where a friends list came from. Never asked on a company import and never sent from one —
   *  see the picker below. `facebook` is the starting value because it is what the drop card the
   *  user just used is called. */
  const [type, setType] = React.useState<string>(isCompany ? "" : "facebook");
  /**
   * HOW THIS IMPORT'S RUN WILL COMPARE — a choice again, on both sides of an import.
   *
   * It was a picker until 2026-08-05, then a sentence, and it is a picker again because the sentence
   * was not merely a narrower option — it was a wall. The mode decides which name column the import
   * gate REQUIRES, so a Thai-only file could not be imported at all while this was pinned to English,
   * and the way out the copy named ("start a Thai run from the Network page") needed rows that this
   * screen had just refused to store.
   *
   * ── WHY THE 2026-08-05 ARGUMENT DOES NOT COME BACK WITH IT ──
   *
   * That removal was aimed at a real habit: people re-uploaded a file they had already imported in
   * order to ask a different question of it, writing a second complete row set to change one column.
   * The fix for that is `POST /compare` existing, which it now does and did not then — the copy below
   * still points at it, so the cheap way to ask again is named on the screen. What the removal added
   * on top of that was a restriction on what could be imported in the first place, and that part was
   * never the point.
   *
   * `DEFAULT_COMPARE_BY` as the starting value, so an importer who touches nothing gets exactly the
   * run this screen has been producing.
   */
  const [compareBy, setCompareBy] = React.useState<CompareBy>(DEFAULT_COMPARE_BY);
  const { language: compareLanguage, type: compareType } = compareByAxes(compareBy);
  // The session arrives a beat after first render (AuthGuard resolves it), so the initial value
  // above can be empty on the first frame. Fill it in when it lands — but never over a value the
  // user has already typed.
  React.useEffect(() => {
    const fromSession = user?.name ?? user?.email ?? "";
    if (fromSession) setUploader((u) => u || fromSession);
  }, [user]);


  /**
   * Columns the user mapped by hand, because detection found none — target column → the header
   * in their file. Empty for the files this app was built around; the escape hatch for every
   * other one, whose column happens to be called something the alias list has never seen.
   */
  const [overrides, setOverrides] = React.useState<ColumnOverrides>(NO_OVERRIDES);

  /**
   * The last preview that came back, held across the next one.
   *
   * A re-preview clears the mutation's `data`, and without this the whole review — table,
   * choices, sample rows — would blink out to a skeleton every time a column is picked, which
   * reads as the screen resetting rather than updating.
   */
  const [shown, setShown] = React.useState<UploadPreview | null>(null);

  const preview = usePreviewUpload();
  const run = useRunComparison();

  const { mutate: runPreview } = preview;

  // Preview as soon as a file arrives, again if it's swapped for another — and again after each
  // column the user maps by hand. Re-read rather than patched: the choice changes the sample
  // rows, the cleaning notes and the warnings, and only the server can say how. It costs one
  // more upload of a small file, which is the same trade the preview itself already makes.
  React.useEffect(() => {
    const form = new FormData();
    form.append(fieldName(source), file);
    if (Object.keys(overrides).length > 0) form.append("columnOverrides", JSON.stringify(overrides));
    /**
     * The two fields the pre-check needs — "have you already imported this?" is a question about
     * WHO and about WHOSE, neither of which is in the file (see `ImportPrecheckSchema`).
     *
     * They are also why this effect re-runs on both: each is one of the two things that turns a
     * refusal into a perfectly ordinary import, so typing either has to re-ask the question live.
     * That is exactly the case people are in when they hit the refusal — the fix is a box on this
     * screen, and a screen that made them re-upload to find out whether it worked would be sending
     * them back through the thing it just refused.
     *
     * The mode used to be the third, and re-previewing on it is the behaviour this replaces: an
     * import is always `en_full` now, so "ask a different question" is no longer something you do
     * by importing at all.
     */
    if (uploader.trim()) form.append("uploaderName", uploader.trim());
    if (owner.trim()) form.append("uploadPersonName", owner.trim());
    if (type) form.append("sourceType", type);
    runPreview(form);
  }, [file, source, overrides, uploader, owner, type, runPreview]);

  // A different file has different headers, so choices made against the old one cannot be
  // carried over — they would name columns this file may not have. `NO_OVERRIDES` is a constant
  // rather than a fresh `{}` so this resetting to "already empty" doesn't re-fire the preview.
  React.useEffect(() => {
    setOverrides(NO_OVERRIDES);
    setShown(null);
  }, [file, source]);

  React.useEffect(() => {
    if (preview.data) setShown(preview.data);
  }, [preview.data]);

  // The held preview carries across a *pending* re-read, never across a failed one: a table
  // sitting under "this file can't be imported" describes a file the server just said it
  // couldn't read, and it would still have a live import button beneath it.
  const data = preview.isError ? null : preview.data ?? shown;
  const busy = run.isPending;
  /** A column choice is in flight: what's on screen is a beat behind the file. */
  const refreshing = preview.isPending && data !== null;

  /**
   * Does the FILE name a relationship owner for each row?
   *
   * Read straight off the preview's `mapping` — the same object the import maps rows through — so
   * the question this screen asks and the behaviour the import has cannot disagree. A second
   * detection pass here would be a second opinion about the same file, and the two would drift.
   *
   * `sourceColumn === null` is the signal, and it is the one "not found" on this screen that is
   * not a problem: most exports have no owner column, and that is exactly when one typed value
   * for the whole import is the right answer.
   */
  const ownerColumn = data?.mapping.find((m) => m.target === "relationship_owner")?.sourceColumn ?? null;

  /**
   * How many rows the FILE leaves without an owner — counted server-side over the whole file, not
   * over the sample on screen, so the box is required for the same files the import would refuse.
   */
  const ownerlessRows = data?.ownerlessRows ?? 0;

  /**
   * The typed owner is OPTIONAL when the file answers for every row, and required otherwise.
   *
   * Half the dedup key is the owner (same owner + same name = duplicate), so a friend filed under
   * nobody dedupes against every other ownerless friend and merges strangers' lists — which is why
   * this cannot simply be left blank on a file that names nobody. What changed is that a file
   * carrying its own owner column has already answered, and being made to retype a name the file
   * already gives is how a required field gets filled with "a".
   *
   * Typed, it is an OVERRIDE and not a fallback: it files every row under that one name, whatever
   * the file says. Company rows dedupe on their own contents and have no owner at all — a contact
   * is nobody's relationship — so none of this is asked on that side.
   */
  const ownerNeeded = !isCompany && ownerlessRows > 0;
  /** The file has its own owner column, so typing here replaces what it says. */
  const ownerOverwrites = !isCompany && !!ownerColumn && !!owner.trim();

  /**
   * THE TWO COLUMNS THIS IMPORT CANNOT DO WITHOUT.
   *
   * A company file must name a company: every comparison is selected by company, so a contact filed
   * under nothing is data that goes in and can never come out.
   *
   * And any file must name somebody in THE LANGUAGE THE RUN WILL COMPARE — one language per run,
   * and the picker above says which. The check offers two fixes because there genuinely are two: map
   * the missing column, or switch the language. It named only the first between 2026-08-05 and
   * 2026-08-10, correctly, because the language was not a choice then — and that is precisely what
   * made a Thai-only file unimportable rather than merely uncompared-for-now.
   *
   * ── THIS IS NOT A CEILING ON EITHER LANGUAGE ──
   *
   * Names in BOTH languages are stored, in full, whatever the mode: the import gate has never
   * filtered by language and must never learn to (see `runLanguage` in comparisons.route.ts). What
   * the mode changes is only which question the run this import opens asks — the other language stays
   * on file and stays comparable by a later run.
   *
   * Both mirror gates in comparisons.route.ts, computed from counts the server sent, so the button
   * is disabled exactly when the request would be refused. Neither is a guess made on screen.
   */
  const scorable = data?.scorableRows?.[compareLanguage] ?? 0;
  /** The count for the language the run is NOT using — the whole of what makes the refusal
   *  actionable. "0 English, 512 Thai" names its own fix; "0 English" alone does not. */
  const scorableOther = data?.scorableRows?.[compareLanguage === "th" ? "en" : "th"] ?? 0;
  /** No row this run could score: the comparison would come back empty, and an empty comparison
   *  reads as "nobody knows these people" rather than "this file had no names in that language". */
  const noScorableNames = !!data && data.totalRows > 0 && scorable === 0;
  /** A company file where no row names a company — an unmapped column and an empty one both land
   *  here, because from the data's point of view they are the same thing. */
  const noCompany = !!data && isCompany && data.totalRows > 0 && data.companylessRows >= data.totalRows;

  /**
   * HOW MANY ROWS THIS IMPORT WOULD ACTUALLY WRITE.
   *
   * Read off the PRE-CHECK, which computed it from the same function the merge drops rows with, so
   * the number on the button is the number the import reports afterwards. Falls back to the file's
   * row count for a server predating the field — the pessimistic direction would be zero, which
   * would disable the button over a payload shape rather than over the data.
   */
  const willImport = data?.precheck?.newRows ?? data?.totalRows ?? 0;

  /**
   * Nothing left to write — the one case the server refuses, and the same predicate it refuses on,
   * so the button and the 400 cannot drift.
   */
  const nothingToImport = !!data?.precheck && precheckBlocks(data.precheck);

  // `refreshing` bars the button while a column choice is still being read back: the table on
  // screen describes the file as it was mapped a moment ago, and importing against it would be
  // importing something the user hasn't been shown.
  const canImport =
    !!data &&
    data.totalRows > 0 &&
    !nothingToImport &&
    !noScorableNames &&
    !noCompany &&
    (!ownerNeeded || !!owner.trim()) &&
    !!uploader.trim() &&
    !busy &&
    !refreshing;

  async function commit() {
    if (!canImport || !data) return;
    const form = new FormData();
    form.append(fieldName(source), file);
    // The wire field keeps its name; what it carries is the import's relationship owner. Sent
    // only when something was typed — an empty string here would be indistinguishable from "the
    // user answered", and on a file that names an owner per row the answer is already in the file.
    if (owner.trim()) form.append("uploadPersonName", owner.trim());
    form.append("uploaderName", uploader.trim());
    if (type) form.append("sourceType", type);
    /**
     * The mode this screen showed, sent unconditionally.
     *
     * Not `if (compareBy !== DEFAULT_COMPARE_BY)`: the server defaults an absent field to the same
     * value, so the conditional would behave identically today and would silently stop matching the
     * screen the day either default moves. The gate above and the run below have to be graded on the
     * same value the reader was looking at, which means sending it.
     */
    form.append("compareBy", compareBy);
    // The same choices the preview above was drawn from, byte for byte — this is what makes the
    // screen a promise rather than a demonstration.
    if (Object.keys(overrides).length > 0) form.append("columnOverrides", JSON.stringify(overrides));
    form.set("name", file.name); // the upload's name is the file it came from
    try {
      // One request does the whole job — the server forwards the new rows to the ingestion
      // webhook itself before responding, so a closed tab can't strand a run that was
      // imported but never sent.
      const result = await run.mutateAsync(form);
      const added = isCompany ? result.companyAdded : result.facebookAdded;
      const dupes = isCompany ? result.companyDuplicates : result.facebookDuplicates;

      // With the external matcher on, the import *started a run* — the API says so by handing
      // back the run's id. The import is not the end of the story, so neither is this screen:
      // go to the run's own page, the one canonical place a run is watched (live or historical).
      // The run is already saved, so leaving here loses nothing.
      if (result.comparisonId) {
        toast.success(
          `Imported ${added.toLocaleString()} row${added === 1 ? "" : "s"} — matching now`
        );
        router.push(`/comparisons/${result.comparisonId}`);
        return;
      }

      /**
       * There is no "nothing new to import" any more, and its removal IS the fix.
       *
       * A re-import used to add no rows, open no run, and land here on a dead-end callout that had
       * to explain that the "How to compare" the user had just picked was not used. That was the
       * reported bug: re-importing the same file to ask a DIFFERENT question is the commonest
       * reason anyone re-imports, and it did nothing.
       *
       * Imports stack now, so this file has a complete row set of its own whether or not those
       * people were already on file, and the branch above always takes it to the run. What used to
       * be `added === 0` is now `duplicates === added` — the same situation, reported rather than
       * refused. Reaching here at all means the internal matcher is on, where an import really is
       * just an import.
       */
      toast.success(
        dupes > 0
          ? `Imported ${added.toLocaleString()} row${added === 1 ? "" : "s"} (${dupes.toLocaleString()} already on file)`
          : `Imported ${added.toLocaleString()} row${added === 1 ? "" : "s"}`
      );
      onComplete?.();
    } catch {
      /* mutations surface errors as toasts */
    }
  }



  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-primary" />
          <span className="truncate font-medium">{file.name}</span>
          {data && (
            <Badge variant="secondary" className="shrink-0">
              {data.totalRows.toLocaleString()} row{data.totalRows === 1 ? "" : "s"}
            </Badge>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          <X className="h-4 w-4" /> Choose another file
        </Button>
      </div>

      {/* Only while there is nothing to show. Once there is, a re-read leaves the table up and
          dims it instead — see `refreshing`. */}
      {preview.isPending && !data && <Skeleton className="h-48 w-full rounded-lg" />}

      {preview.isError && (
        <Callout tone="danger" title="This file can't be imported">
          {preview.error instanceof ApiError
            ? preview.error.message
            : "The file could not be read."}
        </Callout>
      )}

      {/*
        THE IMPORT ADDED NOTHING — said in place of the review, not on top of it.
        ─────────────────────────────────────────────────────────────────────────
        This was an AlertDialog until 2026-08-04, and it had to stop being one the moment it grew
        a second action. Opening the run dialog from inside it swapped one Radix modal for another
        in a single commit: the closing layer's cleanup (focus restore, dismissable-layer teardown)
        landed after the new Dialog had mounted, so the click that opened it was read as an outside
        interaction and dismissed it again — and since dismissal here also meant "the import is
        finished", that took the whole review down with it. From the outside: pick a company, and
        the screen jumps back to the file picker.

        Inline removes the class of bug rather than timing around it. There is only ever one modal
        on screen, opened over an ordinary page — the same shape the Network page has always used.

        It REPLACES the review body (`data && …` below is gated on this being null) for the reason
        the dialog originally covered it: the import is over, and leaving a live "Upload & run 412
        rows" button underneath only invites the same no-op a second time.
      */}
      {data && (
        <>
          <ColumnMap
            preview={data}
            overrides={overrides}
            onPick={(target, header) =>
              setOverrides((prev) => {
                // "Leave empty" STORES null rather than dropping the key. Dropping it means
                // "resolve this target however you would have", which for a column detection got
                // wrong puts the wrong column straight back — the one answer that can't help.
                // See `ColumnOverridesSchema`: absent and null are deliberately different words.
                return { ...prev, [target]: header };
              })
            }
            disabled={busy}
            refreshing={refreshing}
          />

          {/*
            THE COMPANY COLUMN IS MISSING — said directly under the table that fixes it.

            Not a warning among warnings: this one bars the import, because a contact with no
            company is not in any set a run can select and so can never be compared at all. It sits
            here rather than beside the button because the fix is one row up — pick the column —
            and an error a scroll away from its own remedy is how a required field gets read as a
            wall rather than as an instruction.
          */}
          {noCompany && (
            <Callout tone="danger" title="No company on any row">
              <p>
                Every comparison is selected by company, so a contact filed under nothing could never
                be compared — it would go in and never come out. This file can&apos;t be imported
                until it names one.
              </p>
              <p>
                Pick the company column in the table above. If the file genuinely has none, add it
                and export again.
              </p>
            </Callout>
          )}

          {/* The typed owner rides down into the table: it is what every row will be filed under
              once it is typed — the file's own owner column included — and this is the only place
              that can be seen before the import. */}
          <SampleRows preview={data} owner={owner.trim()} />

          {data.warnings.length > 0 && (
            <Callout tone="warning" title="Worth checking">
              <ul className="ml-4 list-disc space-y-0.5">
                {data.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Callout>
          )}

          {/* "Have you already imported this?" — said here, before the button, rather than as a 400
              after it. The server computes the verdict and refuses the blocking one from the same
              function, so this is a preview of the answer and not a second opinion. */}
          <PrecheckNote precheck={data.precheck} />

          <div className="space-y-5 border-t pt-5">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="import-uploader" className="text-xs">
                  Uploaded by <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="import-uploader"
                  value={uploader}
                  onChange={(e) => setUploader(e.target.value)}
                  placeholder="e.g. Alex"
                  disabled={busy}
                />
                <p className="text-xs text-muted-foreground">
                  You, unless you&apos;re importing from a shared account.
                </p>
              </div>

              {/*
                The owner input is always on screen for a friends import, but it is only REQUIRED
                when the file leaves a row unowned. Both the requirement and the wording are driven
                off the preview — `ownerlessRows` and the mapping — so the screen cannot ask for
                something the import doesn't need, or stay quiet about something it does.
              */}
              {!isCompany && (
                <div className="space-y-1.5">
                  <Label htmlFor="import-relationship-owner" className="text-xs">
                    Relationship owner{" "}
                    {ownerNeeded ? (
                      <span className="text-destructive">*</span>
                    ) : (
                      <span className="font-normal text-muted-foreground">(optional)</span>
                    )}
                  </Label>
                  <Input
                    id="import-relationship-owner"
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                    placeholder={ownerColumn ? `Leave empty to use ${ownerColumn}` : "e.g. Alex"}
                    disabled={busy}
                  />
                  <p className="text-xs text-muted-foreground">
                    {ownerColumn ? (
                      <>
                        This file names an owner per friend (
                        <code className="font-mono">{ownerColumn}</code>).{" "}
                        {ownerOverwrites ? (
                          // Typed. Say what it is doing to the file's own column, in the present
                          // tense, and how to undo it — the table above is already showing it.
                          <>
                            What you typed{" "}
                            <span className="font-medium text-foreground">replaces</span> it: all{" "}
                            {data.totalRows.toLocaleString()} row
                            {data.totalRows === 1 ? "" : "s"} will be filed under this name instead.
                            Clear the box to give each row back its own.
                          </>
                        ) : ownerlessRows > 0 ? (
                          // Answered, but not everywhere — the one case where the file has a column
                          // and a name is still required. Worth being blunt that filling the gap
                          // costs the rest: it is an override, not a patch for the blank cells.
                          <>
                            <span className="font-medium text-foreground">
                              {ownerlessRows.toLocaleString()} row
                              {ownerlessRows === 1 ? "" : "s"} leave it blank
                            </span>
                            , so a name is needed here — and it will be used for every row, not only
                            the blank ones.
                          </>
                        ) : (
                          <>
                            You don&apos;t have to add one: leave this empty and each row keeps its
                            own owner. Type a name and it replaces the file&apos;s, on every row.
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        Whose friends these are — the person to ask for an introduction. Your file
                        names nobody, so this one name is applied to{" "}
                        <span className="font-medium text-foreground">
                          all {data.totalRows.toLocaleString()} row
                          {data.totalRows === 1 ? "" : "s"}
                        </span>
                        ; it fills the table above as you type. Friends are deduplicated per owner,
                        so this also decides who counts as a repeat.
                      </>
                    )}
                  </p>
                </div>
              )}

              {/*
                Friends only, and this is the file's PROVENANCE — not the run's compare scope.

                It answers *where these contacts came from* — a Facebook export, LinkedIn, a stack
                of business cards — which is a question about a friends list and not about a company
                file. A company export is company data whatever tool produced it, and the server has
                always stored NULL in `upload.source` for one; offering a picker that writes nothing
                would be asking for an answer nobody reads.

                It belongs HERE, beside the other facts about the import, and NOT in the "How to
                compare" box below. It was moved there briefly and moved straight back: that box
                holds per-run settings, and this writes `friend.source` on every row permanently.
                Filing a permanent property of the data among the run's settings made it read as a
                compare-scope selector, which is a different field with a different lifetime.
              */}
              {!isCompany && (
                <TypePicker id="import-type" value={type} onChange={setType} disabled={busy} />
              )}
            </div>

            {/*
              WHAT THIS IMPORT'S RUN WILL DO — configured again, on both sides of an import.

              ── THE PICKER LEFT ON 2026-08-05 AND CAME BACK ON 2026-08-10 ──

              It was removed because people were re-uploading a file they had already imported in
              order to ask a different question of it: that wrote a second complete row set and put a
              second paid job through the workflow to change one column on the run above it. The box
              became two sentences — what the import WILL do, and where to go to ask something else.

              What that missed is that this control is not only a run setting on this screen. It also
              decides which name column the import GATE requires (see `noScorableNames`), so pinning
              it to English pinned which files could be imported at all: a Thai-only friends list was
              refused outright, and the "go to Network → Results" advice needed rows the same screen
              had just declined to store. A door was closed on the file, not just on the question.

              So the picker is back and the pointer to the compare dialog STAYS — it is what keeps
              the original argument answered. Asking a different question of data already on file is
              one click on a run, and the copy below says so; nobody has to re-upload to re-ask.

              "Whose friends" (the compare-source picker, company imports only) did NOT come back, and
              the difference is worth stating: it narrows which friends ALREADY ON FILE a run covers,
              which is a fact about the database rather than about the file in hand, and no import can
              be blocked by it. That one really was only a run setting, and it lives on the dialog.
            */}
            <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
              <p className="text-sm font-medium">How this import is compared</p>

              {/*
                The shared control, not a second copy of one — `CompareModeControl` is the same
                component the compare dialog uses, so the two screens cannot drift into describing one
                stored value differently. It carries its own explanation of what the chosen cell does,
                including the part a label cannot say: that the other language's names are stored and
                simply not part of THIS run.
              */}
              <CompareModeControl
                idPrefix="import-compare"
                value={compareBy}
                onChange={setCompareBy}
                disabled={busy}
              />

              {/* What the choice means for this particular import, in the terms of the file on
                  screen — the control above explains the mode, this says what it does here. The
                  company side names its denominator because that is the half a reader misreads: an
                  import of 40 contacts is scored against every friend on file, not against 40. */}
              <p className="text-xs text-muted-foreground">
                This import is compared on{" "}
                <span className="font-medium text-foreground">
                  {LANGUAGE_LABEL[compareLanguage]} {TYPE_LABEL[compareType].toLowerCase()}
                </span>
                {isCompany ? (
                  <>
                    , against{" "}
                    <span className="font-medium text-foreground">every friend on file</span>
                  </>
                ) : null}
                .{" "}
                {compareLanguage === "th" ? "English" : "Thai"} names in this file are still stored.
              </p>
              {/*
                THIS IS THE FIRST QUESTION, NOT THE ONLY ONE — kept from the build where the picker
                above did not exist, because it is what answers the objection that removed it. Somebody
                who wants a different answer LATER must not learn to re-upload the file to get it, and
                the only defence against that habit is naming the cheap path on the screen where the
                expensive one is.

                It names ONE place, and that place has moved twice — first off the Network header's
                "Find connections", then off the Uploads table's own Compare button, both removed on
                2026-08-06. Worth re-checking against the app whenever a control moves: copy that
                names a button is only as good as the button.
              */}
              <p className="text-xs text-muted-foreground">
                Asking something else of this data later costs no re-upload —{" "}
                {isCompany ? "one roster instead of all of them, another language, " : "another language, "}
                or just the surname — go to{" "}
                <span className="font-medium text-foreground">Network → Results</span> once this
                import&apos;s run appears and press Compare on it.
              </p>

              {/*
                THE FILE HAS NOTHING THIS RUN COULD SCORE — said here, where both fixes are.

                The import is barred (see `noScorableNames`) and the server refuses the same request
                for the same reason, but being told by a 400 after the upload is the wrong place to
                learn it.

                TWO WAYS OUT, and which one leads is decided by the data rather than by taste. While
                the mode was fixed there was only one (map the column) and it was right to lead with
                it. Now that the language is a choice, `scorableOther` says which case this is: a file
                holding 512 Thai names and no English ones wants the language switched — that is not a
                workaround, it is the correct reading of the file — while a file with none of either
                has an unmapped column and switching would only move the refusal.
              */}
              {noScorableNames && (
                <Callout
                  tone="danger"
                  title={`No ${LANGUAGE_LABEL[compareLanguage]} names in this file`}
                >
                  <p>
                    This import is set to compare{" "}
                    <span className="font-medium">{LANGUAGE_LABEL[compareLanguage]}</span> names, and
                    not one of the {data.totalRows.toLocaleString()} row
                    {data.totalRows === 1 ? "" : "s"} has one — so its comparison would score nothing
                    at all.
                  </p>
                  {scorableOther > 0 ? (
                    <p>
                      {scorableOther.toLocaleString()} of them do have a{" "}
                      <span className="font-medium">
                        {LANGUAGE_LABEL[compareLanguage === "th" ? "en" : "th"]}
                      </span>{" "}
                      name. Switch the language above to compare those instead — or, if this file was
                      meant to have {LANGUAGE_LABEL[compareLanguage]} names, pick that column in the
                      table above.
                    </p>
                  ) : (
                    <p>
                      No row has a name in either language, so no column has been recognised as the
                      names — pick it in the table above.
                    </p>
                  )}
                </Callout>
              )}
              {/*
                What the Type above implies for THIS run — stated, not asked.

                A friends import's run scores the rows this file just brought in, and every one of
                them carries that single type, so there is no compare-scope choice to make on this
                path: the population IS the file. That is why this is a sentence rather than a
                second picker. Choosing which friends to compare is the comparison dialog's job,
                over the friends already on file — reached from Network → Results since 2026-08-06.
              */}
              {!isCompany && type && (
                <p className="text-xs text-muted-foreground">
                  This run covers the {sourceLabel(type)} friends in this file. To compare across
                  sources already on file, press Compare on a run under{" "}
                  <span className="font-medium">Network → Results</span>.
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-3">
              {/* Why the button is dead, beside the button. Both reasons are explained in full
                  further up — this is the pointer for a long file where the callout has scrolled
                  away, and it says which of them applies rather than "something is wrong". */}
              {(noCompany || noScorableNames || nothingToImport) && (
                <p className="text-xs text-destructive">
                  {noCompany
                    ? "Pick the company column above to import."
                    : noScorableNames
                      ? `Nothing here can be compared in ${LANGUAGE_LABEL[compareLanguage]} — see above.`
                      : "Every row is already on file — see above."}
                </p>
              )}
              {/*
                ONE BUTTON, and it counts what will actually be WRITTEN.

                There is no "Import anyway" any more, because there is nothing left to override:
                duplicate rows are dropped whatever you press, and a file with none left to write is
                an import that would store nothing. Offering a second button for that would be
                offering to create an empty upload and a run with nothing in it.

                The count is `newRows` and not `totalRows` — the promise on the face of the button
                has to be the number of rows that exist afterwards, or a 500-row file that is 480
                repeats would say "Upload & run 500 rows" and then report 20.
              */}
              <LoadingButton
                variant="gradient"
                isLoading={busy}
                disabled={!canImport}
                onClick={() => commit()}
              >
                <Upload className="h-4 w-4" />
                {willImport > 0
                  ? `Upload & run ${willImport.toLocaleString()} row${willImport === 1 ? "" : "s"}`
                  : "Nothing to import"}
              </LoadingButton>
            </div>
          </div>
        </>
      )}

    </div>
  );
}

/**
 * WHAT OF THIS FILE IS ALREADY HERE — said before the button rather than after it.
 *
 * Duplicate rows are dropped at write time now (see `ImportPrecheckSchema`), so this is not a
 * warning about a refusal — it is the account of what the import is about to leave out. That
 * distinction is the whole design: the reader is not being stopped, they are being shown.
 *
 * Two tones, because there are two situations and only one of them costs anything. Some rows
 * dropped is an ordinary import with a footnote; EVERY row dropped is an import that would write
 * nothing, which is the one case the server refuses — and there is no "import anyway", because
 * there would be nothing to import.
 */
function PrecheckNote({ precheck }: { precheck: ImportPrecheck | undefined }) {
  // Nothing already here, nothing to say. Undefined only from a server predating the field.
  if (!precheck || precheck.duplicateRows === 0) return null;

  const dropped = precheck.duplicateRows.toLocaleString();
  const kept = precheck.newRows.toLocaleString();
  const prior = precheck.priorImport;
  const priorDate = prior ? new Date(prior.createdAt).toLocaleDateString() : null;
  /**
   * The import these rows are already on file from — linked to the page that lists it.
   *
   * `/uploads` rather than a per-import URL, because there is no such page: an import is a row in
   * a table with a rollback beside it, which is exactly where somebody told "you already have
   * these" wants to be sent.
   */
  const priorLink = prior ? (
    // An ANCHOR on this page, not a link off it: the import history sits below these drop zones
    // (`#past-imports` on /uploads), so "you already imported these" can point at the named import
    // without taking the reader away from the file they are part-way through deciding about.
    <Link href="/uploads#past-imports" className="font-medium underline-offset-2 hover:underline">
      {prior.name || `import ${prior.id}`}
    </Link>
  ) : null;
  const from =
    prior && priorDate ? (
      <>
        {" "}
        from {prior.uploadedBy ? `${prior.uploadedBy}'s ` : "your "}
        {priorLink} on {priorDate}
      </>
    ) : null;

  // Every row would be dropped — the one case the import is refused, because it would write
  // nothing. The button is dead and the way forward is a change to what gets recorded.
  if (precheck.newRows === 0) {
    return (
      <Callout tone="warning" title="Nothing here to import">
        <p>
          All {dropped} row{precheck.duplicateRows === 1 ? " is" : "s are"} already on file, exactly
          as {precheck.duplicateRows === 1 ? "it is" : "they are"} in this file{from}. Importing
          would store nothing and compare nothing.
        </p>
        <p>
          If these are someone else&apos;s friends, put their name in{" "}
          <span className="font-medium">Relationship owner</span> below; if someone else is
          importing, change <span className="font-medium">Uploaded by</span>. To compare what is
          already here — in Thai, or on surnames — press Compare on the earlier import&apos;s run
          under <span className="font-medium">Network → Results</span>.
        </p>
      </Callout>
    );
  }

  return (
    <Callout tone="info" title={`${dropped} row${precheck.duplicateRows === 1 ? "" : "s"} will be skipped`}>
      <p>
        {precheck.duplicateRows === 1 ? "One row is" : `${dropped} rows are`} already on file exactly
        as written here{from}, so {precheck.duplicateRows === 1 ? "it" : "they"} won&apos;t be stored
        again. <span className="font-medium text-foreground">{kept}</span> row
        {precheck.newRows === 1 ? "" : "s"} will be imported and compared.
      </p>
      {/* WHICH ones — marked in the table above, which is the difference between a number and an
          answer. Only said when at least one of them is actually visible up there; on a 4,000-row
          file whose duplicates all sit past the sample, pointing at the table would be pointing at
          nothing. */}
      <p>
        A row counts as already here only when every column matches — including the relationship
        owner and who imported it. Skipped rows are struck through in the sample above.
      </p>
    </Callout>
  );
}

/** Radix reserves the empty string, so "no column" needs a value of its own. It can never collide
 *  with a header: it is translated to an explicit `null` choice the moment it is picked. */
const NO_COLUMN = "__none__";

/**
 * Which column of the file lands in which column of the table — and the place to say which one
 * should, for every row, whatever detection made of it.
 *
 * A "not found" here is still how you catch a wrong export before it is in the database. What has
 * changed is what you can do about it: detection knows the exports this app was written against,
 * so a file whose name column is called "ชื่อ-นามสกุล" or "Contact (full)" used to be a dead end
 * — the column was silently dropped and the only fix was to rename the header and export again.
 *
 * EVERY pickable row is a picker now, over EVERY header in the file. It used to be only the rows
 * nothing was found for, over only the file's spare columns, and both halves of that turned out to
 * be the bug rather than the restraint they were meant as:
 *
 *   · A wrong detection was unfixable. A file whose "eng" column is a department, not a name, has
 *     that column locked to "English name" with no way to move it or empty it — and the column
 *     that DOES hold the names sits under it, unofferable, because the target it belongs to
 *     already "found" something.
 *   · A spare-columns-only list can be empty. Every header claimed by something means every picker
 *     on the screen offers nothing, on exactly the file where the mapping is most likely wrong.
 *
 * The cost is a screen of dropdowns on a file that needed none, which is a cosmetic price for a
 * dead end. What detection decided is still what each one shows, so an untouched screen imports
 * what it always did.
 */
function ColumnMap({
  preview,
  overrides,
  onPick,
  disabled,
  refreshing,
}: {
  preview: UploadPreview;
  overrides: ColumnOverrides;
  onPick: (target: string, header: string | null) => void;
  /** The import is running — nothing about it can be changed now. */
  disabled?: boolean;
  /** A choice is being read back; the table describes the file as it was mapped a moment ago. */
  refreshing?: boolean;
}) {
  // Which headers nothing claims. No longer the pool a pick comes from — that is every header now
  // — but still worth telling apart: a column already feeding another target is a odd thing to
  // point a second one at, and the list says so rather than hiding it.
  const spare = new Set(preview.ignoredColumns);

  /** Where each header currently lands, so the picker can say "this one is already in use, as
   *  Company" instead of offering it as though it were free. */
  const usedBy = new Map<string, string>();
  for (const m of preview.mapping) {
    if (m.sourceColumn) usedBy.set(m.sourceColumn, m.label);
    if (m.alsoColumn) usedBy.set(m.alsoColumn, m.label);
  }

  /**
   * A slot nothing found and nobody can fill is left out entirely.
   *
   * That is exactly one row — the unlabelled name slot (`pickable: false`), which a bilingual
   * file never fills because it says which language each of its name columns is in. Listed, it read
   * "Friend name … not found", which is a report of a problem that isn't one, on a row whose whole
   * point is that there is no question to ask. Every other miss stays: those are questions, and the
   * picker beside them is the answer.
   */
  const rows = preview.mapping.filter((m) => m.sourceColumn !== null || m.pickable !== false);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">Columns</p>
        {refreshing && <span className="text-xs text-muted-foreground">Re-reading the file…</span>}
      </div>
      <div className={cn("overflow-hidden rounded-lg border transition-opacity", refreshing && "opacity-60")}>
        <Table className="min-w-max">
          <TableHeader>
            <TableRow>
              <TableHead>In your file</TableHead>
              <TableHead className="w-8" />
              <TableHead>Imported as</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((m) => {
              // Three states, and the middle one is why `null` is a value the wire carries:
              // no key at all means "whatever detection says", a header means that header, and
              // `null` means "nothing, regardless of what detection found". Without the third,
              // a column detection got WRONG could not be emptied.
              const picked = m.target in overrides ? overrides[m.target] : undefined;
              const shown = picked === undefined ? m.sourceColumn : picked;
              // The unlabelled name slot is the one row nobody can answer: it is routed by script,
              // and "let the app guess the language" is a worse answer than the two rows either
              // side of it that say outright.
              const askable = m.pickable !== false;

              return (
                <TableRow key={m.target}>
                  <TableCell>
                    {askable ? (
                      <Select
                        value={shown ?? NO_COLUMN}
                        onValueChange={(v) => onPick(m.target, v === NO_COLUMN ? null : v)}
                        disabled={disabled}
                      >
                        <SelectTrigger
                          className="h-8 w-[15rem]"
                          aria-label={`Column holding ${m.label}`}
                        >
                          {shown ? (
                            <span className="truncate font-mono text-xs">{shown}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {/* Emptied on purpose reads differently from never found — the
                                  first needs no fixing, and calling it "not found" would nag
                                  about a decision the user just made. */}
                              {picked === null ? "Left empty" : "Not found — pick a column"}
                            </span>
                          )}
                        </SelectTrigger>
                        <SelectContent>
                          {preview.sourceColumns.map((h) => (
                            <SelectItem key={h} value={h} className="font-mono text-xs">
                              {h}
                              {/* Already feeding another target. Offered anyway — moving a column
                                  from the wrong row to the right one is the point — but never
                                  silently, because doing it leaves the other row empty. */}
                              {!spare.has(h) && usedBy.get(h) !== m.label && (
                                <span className="ml-2 font-sans text-muted-foreground">
                                  · in use as {usedBy.get(h)}
                                </span>
                              )}
                            </SelectItem>
                          ))}
                          <SelectSeparator />
                          <SelectItem value={NO_COLUMN} className="text-xs text-muted-foreground">
                            Leave empty
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      // Routed by script rather than chosen — show what it landed on, including
                      // the second half of a split name ("First Name + Last Name").
                      <code className="font-mono text-xs">
                        {m.sourceColumn}
                        {m.alsoColumn && ` + ${m.alsoColumn}`}
                      </code>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <ArrowRight className="h-3.5 w-3.5" />
                  </TableCell>
                  <TableCell className={shown ? "font-medium" : "text-muted-foreground"}>
                    {m.label}
                    {/* Worked out from the data, not from the header — a different kind of answer
                        from an alias match, and the screen has to say which one it is doing. */}
                    {m.guessed && picked === undefined && (
                      <Badge variant="outline" className="ml-2 font-normal text-muted-foreground">
                        guessed
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {preview.ignoredColumns.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {/* No longer just an epitaph — these are exactly the columns the pickers above offer. */}
          Not imported (nothing maps to them):{" "}
          {preview.ignoredColumns.map((c) => (
            <code key={c} className="mr-1 font-mono">
              {c}
            </code>
          ))}
        </p>
      )}
    </div>
  );
}

/** How many sample rows fit on one page of the preview. */
const SAMPLE_PAGE = 10;

/**
 * The owner cell, and the only cell here that can show a value the file does not contain.
 *
 * A friend with no owner is a friend nobody can be asked for an introduction to, and half the
 * dedup key besides — so the import never stores one blank. The typed name is what fills the gap,
 * and it does not only fill gaps: typed, it REPLACES whatever the file said, on every row. Both
 * are the same substitution and both are shown here, in place, in the rows they will land in and
 * styled as what they are — a value from off-screen, not from the file. The replaced value is
 * struck through beneath it, the way a cleaned name shows the text it was cleaned from, because
 * overwriting a column the file did supply is exactly the change worth seeing before it happens.
 */
const ownerCell = (m: ColumnMapping, row: Record<string, string | null>, typed: string) => {
  const fromFile = row[m.target] ?? null;

  // Nothing typed: the file's own answer stands, raw over cleaned like any other name.
  if (!typed) return fromFile === null ? <span className="text-muted-foreground">—</span> : renderCell(m, row);

  return (
    <div className="max-w-[18rem]">
      <span
        className="block truncate italic text-muted-foreground underline decoration-dotted underline-offset-4"
        title={
          fromFile === null
            ? "Not in your file — filled in from the “Relationship owner” field below"
            : "Replaced by the “Relationship owner” field below"
        }
      >
        {typed}
      </span>
      {fromFile !== null && fromFile !== "" && (
        <span className="block truncate text-xs text-muted-foreground line-through" title={fromFile}>
          {fromFile}
        </span>
      )}
    </div>
  );
};

/**
 * The first few rows, already mapped and cleaned — what will actually be written.
 *
 * Shown a page at a time rather than all at once. The preview's job is to catch a bad export
 * before it lands, and the top ten rows of a file are the ten least likely to be wrong: a
 * column that slips, a footer row, an encoding that fails halfway are all things you only see
 * by reading *on*. So the rows are paged through rather than piled up in a wall by default.
 */
function SampleRows({ preview, owner }: { preview: UploadPreview; owner: string }) {
  const total = preview.sampleRows.length;
  const pageCount = Math.max(1, Math.ceil(total / SAMPLE_PAGE));
  const [page, setPage] = React.useState(0);

  // A new file means a new preview — start back at the first page rather than inheriting
  // however far the reader had paged into the last.
  React.useEffect(() => setPage(0), [preview]);

  const start = page * SAMPLE_PAGE;
  const visible = preview.sampleRows.slice(start, start + SAMPLE_PAGE);
  const onLastPage = page >= pageCount - 1;

  /**
   * The columns worth a column: the ones this file actually supplies.
   *
   * The mapping always carries every target, found or not, because it is also what the column
   * picker above is drawn from. Rendering it verbatim put a column of "—" on screen for each one
   * the file doesn't have — most visibly "Friend name", the unlabelled slot, which a bilingual
   * export never fills and nobody can map by hand. A column that is empty in all fifty rows tells
   * you nothing about your data; that it was not found is the column map's job to say, and it
   * says it directly, next to a picker.
   *
   * The owner is the exception and stays whether the file supplies it or not — it is the one
   * column that gets filled from off-screen, and watching it fill is the point of `ownerCell`.
   */
  const columns = preview.mapping.filter((m) => m.sourceColumn !== null || m.target === OWNER_TARGET);
  // Absent on a company import: a contact is nobody's relationship, and there is no such column
  // to explain. Read off the mapping rather than `kind` so the two can't disagree.
  const ownerMapping = preview.mapping.find((m) => m.target === OWNER_TARGET) ?? null;

  if (total === 0 || columns.length === 0) return null;

  // Only the rows on screen can have prompted the question, so only they get to answer it.
  const anyCleaned = visible.some((row) =>
    columns.some((m) => m.cleaned && (row[`${m.target}_clean`] ?? null) !== (row[m.target] ?? null))
  );

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">
        Row{visible.length === 1 ? "" : "s"} {(start + 1).toLocaleString()}
        {visible.length > 1 && `–${(start + visible.length).toLocaleString()}`}{" "}
        <span className="font-normal text-muted-foreground">
          of {preview.totalRows.toLocaleString()}
        </span>
      </p>
      <div className="overflow-hidden rounded-lg border">
        <Table className="min-w-max">
          <TableHeader>
            <TableRow>
              {columns.map((m) => (
                <TableHead key={m.target}>{m.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row, i) => (
              <TableRow key={i}>
                {columns.map((m) => (
                  <TableCell key={m.target}>
                    {m.target === OWNER_TARGET ? ownerCell(m, row, owner) : renderCell(m, row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Page {(page + 1).toLocaleString()} of {pageCount.toLocaleString()}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={onLastPage}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* The pool is finite and smaller than the file. Saying so is the difference between
          "there are no more rows" and "there are no more rows *here*" — the second is true.
          Shown once the reader reaches the last page, so it lands after the whole sample. */}
      {onLastPage && preview.totalRows > total && (
        <p className="text-xs text-muted-foreground">
          That&apos;s the whole sample. The other{" "}
          {(preview.totalRows - total).toLocaleString()} rows aren&apos;t previewed — they
          import the same way these do.
        </p>
      )}

      {ownerMapping && (
        <OwnerNote
          sourceColumn={ownerMapping.sourceColumn}
          owner={owner}
          totalRows={preview.totalRows}
          ownerlessRows={preview.ownerlessRows}
        />
      )}

      {anyCleaned && (
        <p className="text-xs text-muted-foreground">
          <span className="line-through">Struck-through</span> text is what your file says; the name
          beside it is what gets stored — titles (Mr., นาย), suffixes and nicknames removed, the rest
          lower-cased. The original isn&apos;t kept, so check it now.
        </p>
      )}
    </div>
  );
}

/**
 * What the owner column above is saying — and, when it is showing a name the file never gave it,
 * where that name came from.
 *
 * The owner is the one field on this screen answered from two places at once: a column in the file
 * if it has one, and the typed fallback for every row it doesn't. Nothing said so. The column read
 * "—" on a file with no owner column, the input below it read "Relationship owner *", and the link
 * between them — that what you type there lands in every one of those rows — was something you
 * found out by importing. So this says it, in the same words the rows are now drawn in, and names
 * the count so "every row" is a number rather than a promise.
 */
function OwnerNote({
  sourceColumn,
  owner,
  totalRows,
  ownerlessRows,
}: {
  sourceColumn: string | null;
  owner: string;
  totalRows: number;
  /** Rows the file itself leaves unowned — what makes the typed name required rather than spare. */
  ownerlessRows: number;
}) {
  const term = <span className="font-medium text-foreground">relationship owner</span>;
  const name = <span className="font-medium text-foreground">{owner}</span>;
  const marked = <span className="italic underline decoration-dotted underline-offset-4">like this</span>;
  const rows = `${totalRows.toLocaleString()} row${totalRows === 1 ? "" : "s"}`;

  if (sourceColumn) {
    return (
      <p className="text-xs text-muted-foreground">
        The {term} is who to ask for an introduction. Your file names one per row (
        <code className="font-mono">{sourceColumn}</code>).{" "}
        {owner ? (
          <>
            You typed {name}, which <span className="font-medium text-foreground">replaces</span> the
            file&apos;s own owner on all {rows} — shown {marked} above, over the value it replaces. Clear
            the box to give each row back its own.
          </>
        ) : ownerlessRows > 0 ? (
          <>
            {ownerlessRows.toLocaleString()} of them leave it blank, though, and a friend nobody owns
            cannot be asked for an introduction — so type a name below. It applies to all {rows}, not
            just the blank ones.
          </>
        ) : (
          <>
            Leave the box below empty to keep them — a name there overrides the file, putting one owner
            on all {rows}.
          </>
        )}
      </p>
    );
  }

  return (
    <p className="text-xs text-muted-foreground">
      The {term} is who to ask for an introduction — and half of what makes two friends the same
      friend. Your file names nobody, so{" "}
      {owner ? (
        <>
          all {rows} are filed under {name}, shown {marked} above. Change it below and every row changes
          with it.
        </>
      ) : (
        <>
          type a name into “Relationship owner” below and it fills this column for all {rows} — one name
          for the whole import.
        </>
      )}
    </p>
  );
}
