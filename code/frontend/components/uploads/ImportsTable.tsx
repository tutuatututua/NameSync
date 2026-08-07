"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Loader2 } from "lucide-react";
import {
  compareByLabel,
  sourceLabel,
  type ComparisonListItem,
  type UploadSessionRow,
} from "@extensions/contract";
import { Badge } from "@/components/ui/badge";
import { DataManager, type Column } from "@/components/data-table/DataManager";
import {
  UploadFilters,
  EMPTY_FILTERS,
  toUploadParams,
  type UploadFilterState,
} from "@/components/uploads/UploadFilters";
import { useComparisons, useUploadSessions, useUploadSources } from "@/hooks/queries";
import { formatDate } from "@/lib/format";

/**
 * Every import on file — what has already been uploaded, and what became of it.
 *
 * ── WHY THIS IS PART OF UPLOADS AND NOT A NETWORK TAB ──
 *
 * It spent one day as the Network workspace's third tab, on the argument that the three compare
 * scopes (company, owner, file) should each be a tab and the odd one out looked like a different
 * kind of thing. The symmetry was real and it was the wrong thing to organise around: it sorted the
 * screens by what the SERVER does with a row (`filter_by`) rather than by what a person came to do.
 *
 * The question this table answers most often is not "which import shall I re-compare" — it is
 * "have I already uploaded this file?", and that question is asked with a file in hand, standing on
 * the page with the drop zones. Filing the answer one page away meant the check that prevents a
 * duplicate import lived somewhere you had to think to go and look, while the page you were
 * actually on had nothing to say about what it already held.
 *
 * So the import lifecycle is one page again: drop, review, commit, and see the record — with the
 * duplicate precheck's "you already have these, from <import>" pointing down the page rather than
 * off it. The Network workspace keeps the two scopes that are about the network (companies and
 * relationship owners) and gains Results, which is what people come back for.
 *
 * ── IT IS ALSO WHERE A FILE IS COMPARED AGAIN, AND THAT IS NOT A SECOND JOB ──
 *
 * Records, duplicates, status and undo are what tell you whether an import is worth comparing: one
 * showing "Undone" has no rows, and one still "Processing" has no verdicts yet. The row answers
 * "which import" and "is it worth asking" together, so the button that asks belongs on it.
 *
 * Every reader of this page is a writer — `/uploads` is off the reviewer allowlist
 * (`api/src/lib/roles.ts`), which is also why this table needs no role gate of its own: a reviewer
 * cannot reach the page, so it cannot render them a table whose every request 403s.
 */

const LIMIT = 20;

function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

const typeBadge = (type: string | null) =>
  type ? (
    <Badge variant={type === "company" ? "default" : "secondary"} className="capitalize">
      {type}
    </Badge>
  ) : (
    <span className="text-muted-foreground">—</span>
  );

/**
 * EVERY run covering one import, newest first.
 *
 * An import can be scored more than once: the run it opens for itself (`filter_by='upload'`) and
 * any number of "compare that import again" runs over the same rows (`filter_by='file'`). To a
 * reader those are one fact — things that have been asked about this file — and the difference
 * between the two axes is only about which side marks the run completed
 * (docs/EXTERNAL-MATCHER.md).
 *
 * ONE QUERY FOR THE WHOLE TABLE, not one per row. The list of imports is twenty rows; twenty
 * requests to decorate them would be worse than the decoration is worth, and the answer is a
 * single `?filter_by=upload&filter_by=file` away. Grouped here by the scope value, which for both
 * axes IS the upload id.
 */
function useRunsByUpload(): Map<string, ComparisonListItem[]> {
  const { data } = useComparisons({ axes: ["upload", "file"] });
  return React.useMemo(() => {
    const out = new Map<string, ComparisonListItem[]>();
    for (const run of data ?? []) {
      if (!run.filterValue) continue;
      const list = out.get(run.filterValue);
      if (list) list.push(run);
      else out.set(run.filterValue, [run]);
    }
    return out;
  }, [data]);
}

/** How many run links a cell shows before it stops. Beyond this the row is taller than it is
 *  useful, and the count carries the rest. */
const RUNS_SHOWN = 2;

/**
 * Where the import's matching runs can be watched.
 *
 * The row that says "Processing" has to be clickable, and for two reasons. The obvious one is
 * that a page which tells you something is happening and gives you no way to go and look at it
 * is a dead end. The other is structural: the run page's progress poll is *what completes a run*
 * (there is no callback — the API only learns the workflow has finished by counting unstamped
 * rows), so an unreachable run is also an uncompletable one. Before this link, an import whose
 * uploader closed the tab stayed "Processing" forever, and the only cure was to already know the
 * URL.
 *
 * ── IT USED TO SHOW ONE RUN, AND THE OTHERS WERE REACHABLE FROM NOWHERE ──
 *
 * The cell rendered `upload.comparison_id` — the run this import opened for itself. A re-run
 * started elsewhere produced a `file`-scoped comparison that the column knew nothing about, so the
 * second question you asked about a file vanished the moment you navigated away from its results.
 *
 * ── STARTING A RUN IS NOT ONE OF THIS CELL'S JOBS ANY MORE (2026-08-06) ──
 *
 * There was a Compare button in here, scoped to the import. It is gone, and the removal is the
 * point rather than a side effect: a new run is started from Network → Results, which is the one
 * screen whose subject IS runs. This cell LINKS to runs and does not make them.
 *
 * The button had a discoverability problem that made the split easy to argue — icon-only, ghost,
 * wedged beside a stack of run links in a column headed "Runs", where it read as decoration on the
 * links rather than as an action of its own. But the reason it went is the stronger one: an import
 * row's question is "what became of this file", and a control that spends money and writes a
 * `comparison` was answering a different one in the same eight pixels.
 *
 * The way back to a re-run is `+n more under Network → Results`, already in this cell, and the
 * run links themselves — a run's own row on Results carries the Compare that repeats it, scope
 * intact. What is genuinely no longer reachable is a first run over an import that never got one;
 * with the external matcher every import opens one on arrival, so that case is the internal
 * matcher's, and it is called out in the empty branch below.
 */
const runCell = (runs: ComparisonListItem[]) => {
  if (runs.length === 0) {
    // No run has ever covered this import. Under the internal matcher that is every import — it
    // opened none, and its status was final before the response returned. There is nothing to
    // press here now: the dash is the whole answer, and a run over these rows has to be started
    // from a company or an owner rather than from the file.
    return <span className="text-muted-foreground">—</span>;
  }

  return (
    <div className="min-w-0 space-y-0.5">
      {runs.slice(0, RUNS_SHOWN).map((run) => (
        <Link
          key={run.id}
          href={`/comparisons/${run.id}`}
          className="flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
        >
          {/* The MODE, not "View run" — with several runs on one import the only thing telling
              them apart is the question each asked, and "View run" three times is a list of
              identical links. */}
          {compareByLabel(run.compareBy)}
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
        </Link>
      ))}
      {/* Carries more weight now that it is the only pointer off this cell — it names both the
          overflow and the place a re-run is started. */}
      {runs.length > RUNS_SHOWN && (
        <p className="text-xs text-muted-foreground">
          +{runs.length - RUNS_SHOWN} more under Network → Results
        </p>
      )}
    </div>
  );
};

/**
 * What has happened to an import.
 *
 * With the external matcher on, `processing` is where an import *starts* and where it stays
 * until the workflow has stamped every one of its rows — so this column is the honest answer
 * to "is my file done yet?", and it is the reason the column exists at all. Under the internal
 * matcher an import is `completed` before the response returns, and this only ever reads
 * Completed, Failed or Undone.
 */
const statusBadge = (status: string | null) => {
  if (status === "rolled_back") return <Badge variant="secondary">Undone</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (status === "completed") return <Badge variant="success">Completed</Badge>;
  // 'processing' / 'pending' / 'pending_webhook' — the workflow still has it.
  return (
    <Badge variant="outline" className="gap-1.5 text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      Processing
    </Badge>
  );
};

export function ImportsTable() {
  const [filters, setFilters] = React.useState<UploadFilterState>(EMPTY_FILTERS);
  const [page, setPage] = React.useState(1);
  const search = useDebounced(filters.search);

  const params = React.useMemo(
    () => ({ page, limit: LIMIT, ...toUploadParams({ ...filters, search }, "uploadType") }),
    [page, filters.type, filters.source, filters.dateFrom, filters.dateTo, search] // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Any filter change resets to page 1.
  React.useEffect(
    () => setPage(1),
    [filters.type, filters.source, filters.dateFrom, filters.dateTo, search]
  );

  const q = useUploadSessions(params);
  // Every run over every import, in one request, grouped by the upload it covers — see
  // `useRunsByUpload` for why this is not asked per row.
  const runsByUpload = useRunsByUpload();

  // The pick-list, purely for display: it turns the stored 'linkedin' into the 'LinkedIn' the
  // rest of the app shows. Cached hard and already loaded by the toolbar above.
  const sources = useUploadSources();
  const sourceLabels = React.useMemo(
    () => new Map((sources.data ?? []).map((s) => [s.value, s.label])),
    [sources.data]
  );

  const columns: Column<UploadSessionRow>[] = [
    {
      key: "created_at",
      header: "Date",
      className: "whitespace-nowrap text-muted-foreground",
      render: (r) => formatDate(r.created_at),
    },
    {
      key: "name",
      header: "File",
      className: "font-medium text-foreground",
      render: (r) => r.name ?? "—",
    },
    { key: "upload_type", header: "Type", render: (r) => typeBadge(r.upload_type) },
    {
      // WHERE the friends came from, beside WHICH SIDE they are. A dash on a company import is
      // correct and not missing data: contacts came from no roster, which is why the server stores
      // NULL there. Labelled through the pick-list so 'linkedin' reads as 'LinkedIn'.
      key: "source",
      header: "Source",
      className: "text-muted-foreground",
      render: (r) => (r.source ? (sourceLabels.get(r.source) ?? sourceLabel(r.source)) : "—"),
    },
    {
      // "Uploaded by", not "Relationship owner". An import has ONE uploader but may carry many
      // owners — a file can name a different one on every row — so this column can only honestly
      // report who performed the import. Whose relationship each friend is lives on the friend.
      key: "uploaded_by",
      header: "Uploaded by",
      className: "text-muted-foreground",
      render: (r) => r.uploaded_by ?? "—",
    },
    {
      key: "records_uploaded",
      header: "Records",
      className: "text-right tabular-nums",
      render: (r) => (r.records_uploaded ?? 0).toLocaleString(),
    },
    {
      key: "duplicate_records",
      header: "Duplicates",
      className: "text-right tabular-nums text-muted-foreground",
      render: (r) => (r.duplicate_records ?? 0).toLocaleString(),
    },
    { key: "status", header: "Status", render: (r) => statusBadge(r.status) },
    // "Runs", plural: an import can be scored more than once. See `runCell`.
    { key: "comparison_id", header: "Runs", render: (r) => runCell(runsByUpload.get(r.id) ?? []) },
  ];

  return (
    <div className="space-y-4">
      <UploadFilters value={filters} onChange={setFilters} />
      <DataManager<UploadSessionRow>
        rows={q.data?.data ?? []}
        columns={columns}
        getRowId={(r) => r.id}
        total={q.data?.pagination.total ?? 0}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        isLoading={q.isLoading}
        emptyTitle="No imports yet"
        // The drop zones are directly above, so this points at them rather than naming a page.
        emptyText="Drop a company or friends export above and it will be listed here."
      />
    </div>
  );
}
