"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronDown, FileText, Upload, X } from "lucide-react";
import { toast } from "sonner";
import type { ColumnMapping, UploadPreview } from "@extensions/contract";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LoadingButton } from "@/components/loading-button";
import { Callout } from "@/components/callout";
import { ApiError } from "@/lib/api/client";
import { usePreviewUpload } from "@/hooks/mutations";
import { useRunComparison, useSendWebhook } from "@/hooks/mutations";
import { formatDate } from "@/lib/format";

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

/**
 * One sample cell.
 *
 * A name column shows the *cleaned* name — the value that will be matched and displayed —
 * with the original underneath whenever cleaning changed it. Showing only the clean name
 * would hide an edit to the user's data; showing only the raw one would be a lie about what
 * gets stored. Both are written to the database, so both are shown here.
 */
const renderCell = (m: ColumnMapping, row: Record<string, string | null>) => {
  const value = row[m.target] ?? null;
  if (value === null || value === "") return <span className="text-muted-foreground">—</span>;
  if (m.target === "source_timestamp") return <span className="whitespace-nowrap">{formatDate(value)}</span>;

  const clean = m.cleaned ? row[`${m.target}_clean`] ?? null : null;
  const changed = m.cleaned && clean !== value;

  return (
    <div className="max-w-[18rem]">
      <span className="block truncate" title={clean ?? value}>
        {clean ?? value}
      </span>
      {changed && (
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
  const [uploader, setUploader] = React.useState("");

  const preview = usePreviewUpload();
  const run = useRunComparison();
  const send = useSendWebhook();

  const { mutate: runPreview } = preview;

  // Preview as soon as a file arrives, and again if it's swapped for another.
  React.useEffect(() => {
    const form = new FormData();
    form.append(fieldName(source), file);
    runPreview(form);
  }, [file, source, runPreview]);

  // The uploader is half the dedup key for friends (same uploader + same name = duplicate),
  // so a Facebook import can't do without one. Company rows dedupe on their own contents.
  const uploaderRequired = !isCompany;
  const data = preview.data;
  const busy = run.isPending || send.isPending;
  const canImport = !!data && data.totalRows > 0 && (!uploaderRequired || !!uploader.trim()) && !busy;

  async function commit() {
    if (!canImport || !data) return;
    const form = new FormData();
    form.append(fieldName(source), file);
    form.append("uploadPersonName", uploader.trim());
    form.set("name", file.name); // the upload's name is the file it came from
    try {
      const result = await run.mutateAsync(form);
      await send.mutateAsync(result.sessionId); // forward the new rows to the ingestion webhook
      const added = isCompany ? result.companyAdded : result.facebookAdded;
      const dupes = isCompany ? result.companyDuplicates : result.facebookDuplicates;

      // With the external matcher on, the import *started a run* — the API says so by handing
      // back the run's id. The import is not the end of the story, so neither is this screen:
      // go to Compare, which is where a run is watched and where every past run is listed, and
      // hand it the run to follow. The run is already saved, so leaving here loses nothing.
      if (result.comparisonId) {
        toast.success(
          `Imported ${added.toLocaleString()} row${added === 1 ? "" : "s"} — matching now`
        );
        router.push(`/?run=${result.comparisonId}`);
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

      {preview.isPending && <Skeleton className="h-48 w-full rounded-lg" />}

      {preview.isError && (
        <Callout tone="danger" title="This file can't be imported">
          {preview.error instanceof ApiError
            ? preview.error.message
            : "The file could not be read."}
        </Callout>
      )}

      {data && (
        <>
          <ColumnMap preview={data} />
          <SampleRows preview={data} />

          {data.warnings.length > 0 && (
            <Callout tone="warning" title="Worth checking">
              <ul className="ml-4 list-disc space-y-0.5">
                {data.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Callout>
          )}

          <div className="flex flex-wrap items-end justify-between gap-4 border-t pt-5">
            <div className="w-full max-w-xs space-y-1.5">
              <Label htmlFor="import-uploader" className="text-xs">
                Upload user{" "}
                {uploaderRequired ? (
                  <span className="text-destructive">*</span>
                ) : (
                  <span className="font-normal text-muted-foreground">(optional)</span>
                )}
              </Label>
              <Input
                id="import-uploader"
                value={uploader}
                onChange={(e) => setUploader(e.target.value)}
                placeholder="e.g. Alex"
                disabled={busy}
              />
              <p className="text-xs text-muted-foreground">
                {uploaderRequired
                  ? "Friends are deduplicated per uploader, so this is required."
                  : "Recorded as who imported the file. Company rows dedupe on their own contents."}
              </p>
            </div>

            <LoadingButton variant="gradient" isLoading={busy} disabled={!canImport} onClick={commit}>
              <Upload className="h-4 w-4" />
              {data.totalRows > 0
                ? `Import ${data.totalRows.toLocaleString()} row${data.totalRows === 1 ? "" : "s"}`
                : "Nothing to import"}
            </LoadingButton>
          </div>
        </>
      )}
    </div>
  );
}

/** Which column of the file lands in which column of the table. The point of the preview:
 *  a "not found" here is how you catch a wrong export *before* it's in the database. */
function ColumnMap({ preview }: { preview: UploadPreview }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Columns</p>
      <div className="overflow-hidden rounded-lg border">
        <Table className="min-w-max">
          <TableHeader>
            <TableRow>
              <TableHead>In your file</TableHead>
              <TableHead className="w-8" />
              <TableHead>Imported as</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {preview.mapping.map((m) => (
              <TableRow key={m.target}>
                <TableCell>
                  {m.sourceColumn ? (
                    <code className="font-mono text-xs">{m.sourceColumn}</code>
                  ) : (
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
            ))}
          </TableBody>
        </Table>
      </div>

      {preview.ignoredColumns.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Ignored (nothing maps to them):{" "}
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

/** How many sample rows are on screen at first, and how many each "Show 10 more" adds. */
const SAMPLE_PAGE = 10;

/**
 * The first few rows, already mapped and cleaned — what will actually be written.
 *
 * Shown a page at a time rather than all at once. The preview's job is to catch a bad export
 * before it lands, and the top ten rows of a file are the ten least likely to be wrong: a
 * column that slips, a footer row, an encoding that fails halfway are all things you only see
 * by reading *on*. So the rows are there to be asked for, without a wall of them by default.
 */
function SampleRows({ preview }: { preview: UploadPreview }) {
  const total = preview.sampleRows.length;
  const [shown, setShown] = React.useState(SAMPLE_PAGE);

  // A new file means a new preview — start the next one from the top rather than inheriting
  // however far the reader had scrolled into the last.
  React.useEffect(() => setShown(SAMPLE_PAGE), [preview]);

  const visible = preview.sampleRows.slice(0, shown);
  const remaining = total - visible.length;

  if (total === 0) return null;

  // Only the rows on screen can have prompted the question, so only they get to answer it.
  const anyCleaned = visible.some((row) =>
    preview.mapping.some((m) => m.cleaned && (row[`${m.target}_clean`] ?? null) !== (row[m.target] ?? null))
  );

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">
        First {visible.length.toLocaleString()} row{visible.length === 1 ? "" : "s"}{" "}
        <span className="font-normal text-muted-foreground">
          of {preview.totalRows.toLocaleString()}
        </span>
      </p>
      <div className="overflow-hidden rounded-lg border">
        <Table className="min-w-max">
          <TableHeader>
            <TableRow>
              {preview.mapping.map((m) => (
                <TableHead key={m.target}>{m.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row, i) => (
              <TableRow key={i}>
                {preview.mapping.map((m) => (
                  <TableCell key={m.target}>{renderCell(m, row)}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {remaining > 0 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setShown((n) => n + SAMPLE_PAGE)}
        >
          <ChevronDown className="h-4 w-4" />
          Show {Math.min(SAMPLE_PAGE, remaining)} more
        </Button>
      ) : (
        // The pool is finite and smaller than the file. Saying so is the difference between
        // "there are no more rows" and "there are no more rows *here*" — the second is true.
        preview.totalRows > total && (
          <p className="text-xs text-muted-foreground">
            That&apos;s the whole sample. The other{" "}
            {(preview.totalRows - total).toLocaleString()} rows aren&apos;t previewed — they
            import the same way these do.
          </p>
        )
      )}

      {anyCleaned && (
        <p className="text-xs text-muted-foreground">
          Names are cleaned on import — titles (Mr., นาย), suffixes, nicknames and middle names are removed. The{" "}
          <span className="line-through">struck-through</span> value is what your file says; it is stored too, so
          nothing is lost.
        </p>
      )}
    </div>
  );
}
