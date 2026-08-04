"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  FileText,
  GitCompareArrows,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  DEFAULT_COMPARE_BY,
  sourceLabel,
  type ColumnMapping,
  type ColumnOverrides,
  type CompareBy,
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { LoadingButton } from "@/components/loading-button";
import { Callout } from "@/components/callout";
import { CompareModeControl } from "@/components/compare-mode";
import { TypePicker } from "@/components/upload/TypePicker";
import { SourcePicker } from "@/components/source-picker";
import {
  NewComparisonDialog,
  type ComparisonSeed,
} from "@/components/network/NewComparisonDialog";
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
  const [compareBy, setCompareBy] = React.useState<CompareBy>(DEFAULT_COMPARE_BY);
  /**
   * Which friends the run this import starts should cover — COMPANY imports only.
   *
   * A separate piece of state from `type` one line up, and deliberately so: `type` is what this
   * FILE is (written to every row, permanently), this is what the RUN covers (one comparison,
   * re-runnable with a different answer). The two were briefly one control and it made a permanent
   * property of the data read as a per-run setting.
   *
   * Null is every source. A friends import leaves it null and the server ignores it there anyway —
   * that path hands the workflow its own rows, so there is no population to narrow.
   */
  const [compareSources, setCompareSources] = React.useState<string[] | null>(null);

  // The session arrives a beat after first render (AuthGuard resolves it), so the initial value
  // above can be empty on the first frame. Fill it in when it lands — but never over a value the
  // user has already typed.
  React.useEffect(() => {
    const fromSession = user?.name ?? user?.email ?? "";
    if (fromSession) setUploader((u) => u || fromSession);
  }, [user]);

  /**
   * The import landed but added nothing, so no run was opened and there is nowhere to go.
   *
   * Held in state because this is the one outcome that has to be *said*. Every other path
   * either sends you to a run or leaves an obviously changed table behind it; this one looks
   * exactly like a no-op, and a toast that fades after four seconds is not an explanation —
   * it is the reason this case kept getting reported as "the button did nothing".
   */
  const [nothingNew, setNothingNew] = React.useState<{ duplicates: number } | null>(null);

  /**
   * The way OUT of the dialog above — a run over the data that was already on file.
   *
   * This is the whole point of the "nothing new" case, and until 2026-08-04 it was missing: the
   * dialog said what happened and then closed the door, advising "import a file with new rows".
   * That is the wrong instruction for the commonest reason anyone re-imports a file they already
   * have, which is to ask a DIFFERENT QUESTION of it — Thai instead of English, given name instead
   * of full name. Re-importing can never do that (the mode is a property of the run, not of the
   * data) and the thing that can was one click away on another page, unmentioned.
   *
   * Non-null holds the seed the run dialog opens with; see `ComparisonSeed`.
   */
  const [reCompare, setReCompare] = React.useState<ComparisonSeed | null>(null);

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
    runPreview(form);
  }, [file, source, overrides, runPreview]);

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
  // `refreshing` bars the button while a column choice is still being read back: the table on
  // screen describes the file as it was mapped a moment ago, and importing against it would be
  // importing something the user hasn't been shown.
  const canImport =
    !!data &&
    data.totalRows > 0 &&
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
    form.append("compareBy", compareBy);
    // Sent only when the user narrowed, and only from the company path — the field the server
    // reads is separate from `sourceType` above, and an absent value means every source. JSON in
    // a form field, like `columnOverrides` below: multipart carries text, and a repeated field
    // name is read differently by every parser in the chain.
    if (isCompany && compareSources?.length) {
      form.append("compareSources", JSON.stringify(compareSources));
    }
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
       * Nothing new landed — every row of this file was already on file.
       *
       * No run is opened for an import that adds nothing (there would be nothing for the
       * matcher to look at), so unlike the branch above there is no run to send anyone to.
       * Re-importing a file you have already imported is the ordinary way to reach this, and
       * from the outside it is indistinguishable from a broken button: the screen resets and
       * the app appears to have ignored you. Say what happened, on the page you said it on.
       */
      if (added === 0) {
        setNothingNew({ duplicates: dupes });
        return;
      }

      // Internal matcher: an import is just an import. Nothing is running, and there is
      // nowhere to send anyone.
      toast.success(
        `Imported ${added.toLocaleString()} new row${added === 1 ? "" : "s"} (${dupes.toLocaleString()} duplicate${
          dupes === 1 ? "" : "s"
        } skipped)`
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

      {data && (
        <>
          <ColumnMap
            preview={data}
            overrides={overrides}
            onPick={(target, header) =>
              setOverrides((prev) => {
                const next = { ...prev };
                // Clearing removes the key rather than storing null: "said nothing about this
                // target" is exactly what the parser's fall-back-to-detection case reads, and
                // an empty map is how "no choices at all" is spelled everywhere else.
                if (header) next[target] = header;
                else delete next[target];
                return Object.keys(next).length === 0 ? NO_OVERRIDES : next;
              })
            }
            disabled={busy}
            refreshing={refreshing}
          />
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
              The comparison mode lives HERE, and not only on the ad-hoc compare dialog, because
              this is the path that reaches the external matcher: an import auto-starts a run and
              forwards its rows to the workflow, while the dialog runs the internal matcher and
              sends no webhook at all. A mode picked only in the dialog could never configure the
              workflow it was meant for.
            */}
            <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
              <p className="text-sm font-medium">How to compare</p>

              {/*
                COMPANY IMPORTS ONLY — and the asymmetry is the whole reason this is a separate
                field from Type rather than the same one.

                A company import stores contacts and then scores them against the friends ALREADY
                on file, which came from every roster. "Match these against LinkedIn only" is a
                real question, it has a different answer every time it is asked, and nothing about
                the uploaded file implies it.

                A friends import has no such question. Its run scores the rows it just brought in,
                every one of them carrying the single Type chosen above, so a picker here would be
                offering to narrow a set by the property all of its members share. That is stated
                as a sentence below instead of being offered as a control that cannot do anything.
              */}
              {isCompany && (
                <div className="space-y-1.5">
                  <Label htmlFor="import-compare-sources" className="text-xs">
                    Whose friends
                  </Label>
                  <SourcePicker
                    id="import-compare-sources"
                    selected={compareSources}
                    onChange={setCompareSources}
                    disabled={busy}
                  />
                  <p className="text-xs text-muted-foreground">
                    Which friends these contacts are matched against. Not the same as the file&apos;s
                    own type — this applies to this run only.
                  </p>
                </div>
              )}

              <CompareModeControl
                idPrefix="import"
                value={compareBy}
                onChange={setCompareBy}
                disabled={busy}
              />
              {/*
                What the Type above implies for THIS run — stated, not asked.

                A friends import's run scores the rows this file just brought in, and every one of
                them carries that single type, so there is no compare-scope choice to make on this
                path: the population IS the file. That is why this is a sentence rather than a
                second picker. Choosing which friends to compare is the Find-connections dialog's
                job, over the friends already on file.
              */}
              {!isCompany && type && (
                <p className="text-xs text-muted-foreground">
                  This run covers the {sourceLabel(type)} friends in this file. To compare across
                  sources already on file, use Find connections on the Network page.
                </p>
              )}
            </div>

            <div className="flex justify-end">
              <LoadingButton variant="gradient" isLoading={busy} disabled={!canImport} onClick={commit}>
                <Upload className="h-4 w-4" />
                {data.totalRows > 0
                  ? `Upload & run ${data.totalRows.toLocaleString()} row${data.totalRows === 1 ? "" : "s"}`
                  : "Nothing to import"}
              </LoadingButton>
            </div>
          </div>
        </>
      )}

      {/* Closing it returns to the file picker. The import is over — leaving the review up
          with a live "Import 42 rows" button would only invite the same no-op a second time. */}
      <AlertDialog
        open={nothingNew !== null}
        onOpenChange={(open) => {
          if (open) return;
          setNothingNew(null);
          onComplete?.();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Nothing new to import</AlertDialogTitle>
            <AlertDialogDescription>
              {nothingNew && nothingNew.duplicates > 0
                ? `Every row in ${file.name} — all ${nothingNew.duplicates.toLocaleString()} of them — was already imported, so nothing was added and no matching run was started.`
                : `${file.name} added no new rows, so no matching run was started.`}
              {" "}
              {/* The correction to the old copy, which sent people off to re-export a file. An
                  import decides who is on file; a run decides what was asked of them. Only the
                  second one is what somebody re-uploading a file they already have is after. */}
              This data is still on file — to ask a different question of it, such as another
              language or just the given name, start a run instead of importing again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/*
              A plain Button, not an AlertDialogAction: that one closes through Radix, which fires
              `onOpenChange` and hands the screen back to the file picker — resetting the review out
              from under the dialog we are about to open. Clearing `nothingNew` closes this the
              controlled way, silently, and `onComplete` waits until the run dialog is done with.
            */}
            <Button
              variant="gradient"
              onClick={() => {
                setNothingNew(null);
                setReCompare({
                  // Every company: a whole-table run is what "compare this data again" means when
                  // the data in question is the roster, and the file named no company to narrow to.
                  companies: null,
                  // A friends file knows which roster it was — seed it, so the run covers what was
                  // just re-imported rather than silently widening to every source on file. A
                  // company file has no such axis and takes the default (all sources).
                  sources: !isCompany && type ? [type] : null,
                });
              }}
            >
              <GitCompareArrows className="h-4 w-4" />
              Compare these again
            </Button>
            <AlertDialogAction>Close</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Opened only from the dialog above. `onComplete` fires on the way out of THIS one, so the
          review stays put behind it and the file picker returns once the user is actually done. */}
      <NewComparisonDialog
        open={reCompare !== null}
        onOpenChange={(open) => {
          if (open) return;
          setReCompare(null);
          onComplete?.();
        }}
        initial={reCompare ?? undefined}
      />
    </div>
  );
}

/** Radix reserves the empty string, so "no column" needs a value of its own. It can never
 *  collide with a header: it is not offered unless a header is currently chosen, and it is
 *  translated back to null the moment it is picked. */
const NO_COLUMN = "__none__";

/**
 * Which column of the file lands in which column of the table — and, where nothing landed, the
 * place to say which one should.
 *
 * A "not found" here is still how you catch a wrong export before it is in the database. What has
 * changed is what you can do about it: detection knows the exports this app was written against,
 * so a file whose name column is called "ชื่อ-นามสกุล" or "Contact (full)" used to be a dead end
 * — the column was silently dropped and the only fix was to rename the header and export again.
 * Now the row that reports the miss also offers the file's own spare columns.
 *
 * Only a target with nowhere to come from gets a picker (plus one already chosen, so a choice can
 * be changed or taken back). A column detection DID find is left alone deliberately: it is right
 * nearly always, it agrees with what the import has always done, and turning every row into a
 * control invites re-mapping a file that needed nothing.
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
  // The pool a hand-mapped column comes from: the headers no target claims. A header already
  // feeding one column is not offered to a second, so a single column can't quietly land in two
  // places — and since this list is rebuilt from each preview, a column chosen here leaves the
  // pool for every other target as soon as the choice lands.
  const spare = new Set(preview.ignoredColumns);

  /**
   * A slot nothing found and nobody can fill is left out entirely.
   *
   * That is exactly one row — the unlabelled `friend_name` (`pickable: false`), which a bilingual
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
              const chosen = overrides[m.target] ?? null;
              // The chosen header stays on its own list even though it is no longer spare —
              // otherwise the one column you can undo is the one you can't see.
              const options = preview.sourceColumns.filter((h) => spare.has(h) || h === chosen);
              // Nothing found it, or the user pointed it somewhere by hand. Either way this row
              // is a question, not a statement — unless the server says the target isn't one
              // anybody can answer (`pickable: false`: the unlabelled name, routed by script).
              const askable = m.pickable !== false && (!m.sourceColumn || chosen !== null);

              return (
                <TableRow key={m.target}>
                  <TableCell>
                    {askable && options.length > 0 ? (
                      <Select
                        value={chosen ?? NO_COLUMN}
                        onValueChange={(v) => onPick(m.target, v === NO_COLUMN ? null : v)}
                        disabled={disabled}
                      >
                        <SelectTrigger
                          className="h-8 w-[15rem]"
                          aria-label={`Column holding ${m.label}`}
                        >
                          {chosen ? (
                            <span className="truncate font-mono text-xs">{chosen}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              Not found — pick a column
                            </span>
                          )}
                        </SelectTrigger>
                        <SelectContent>
                          {options.map((h) => (
                            <SelectItem key={h} value={h} className="font-mono text-xs">
                              {h}
                            </SelectItem>
                          ))}
                          {chosen && (
                            <>
                              <SelectSeparator />
                              <SelectItem value={NO_COLUMN} className="text-xs text-muted-foreground">
                                Leave empty
                              </SelectItem>
                            </>
                          )}
                        </SelectContent>
                      </Select>
                    ) : m.sourceColumn ? (
                      <code className="font-mono text-xs">{m.sourceColumn}</code>
                    ) : (
                      // Nothing found it and the file has no spare column to offer — every
                      // header it has is already feeding something else.
                      <Badge variant="outline" className="text-muted-foreground">
                        not found
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <ArrowRight className="h-3.5 w-3.5" />
                  </TableCell>
                  <TableCell className={m.sourceColumn ? "font-medium" : "text-muted-foreground"}>
                    {m.label}
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
