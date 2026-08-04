"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Building2, Loader2, Users } from "lucide-react";
import { sourceLabel, type UploadSessionRow } from "@extensions/contract";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataManager, type Column } from "@/components/data-table/DataManager";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { UploadPanel } from "@/components/upload/UploadPanel";
import { ImportReview, type ImportSource } from "@/components/upload/ImportReview";
import {
  UploadFilters,
  EMPTY_FILTERS,
  toUploadParams,
  type UploadFilterState,
} from "@/components/uploads/UploadFilters";
import { useUploadSessions, useUploadSources } from "@/hooks/queries";
import { formatDate } from "@/lib/format";
import { UPLOAD_ACCEPT } from "@/lib/files";

/**
 * Uploads — the import lifecycle, in the order you live it: put a file in, check what it
 * holds, commit it, and see (or undo) what you've committed before.
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

export default function UploadsPage() {
  return (
    <div className="space-y-10">
      <PageHeader
        title="Uploads"
        description="Import company data or friends, review what each import added, and undo one."
      />

      <ImportSection />

      <section className="space-y-4">
        <SectionHeader
          title="Import sessions"
          description="Every import is its own audit record — and its own undo."
        />
        <SessionsList />
      </section>
    </div>
  );
}

/**
 * Two drop targets; once a file lands, the whole section becomes that file's review. The
 * review needs the full width — a column map and eight sample rows do not fit in half of
 * one — and there's no reason to keep the other drop zone on screen while you're deciding
 * about this one.
 */
function ImportSection() {
  const [picked, setPicked] = React.useState<{ source: ImportSource; file: File } | null>(null);

  if (picked) {
    return (
      <Card>
        <CardContent className="p-5">
          <ImportReview
            source={picked.source}
            file={picked.file}
            onCancel={() => setPicked(null)}
            onComplete={() => setPicked(null)}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <DropCard
        source="company"
        icon={Building2}
        title="Company data"
        subtitle="A company export — Excel, CSV or JSON"
        accept={UPLOAD_ACCEPT}
        onFile={(file) => setPicked({ source: "company", file })}
      />
      {/* "Friends", not "Facebook": the social side takes LinkedIn exports and typed-up business
          cards too. The `facebook` source value, the `facebookFile` form field and the `friend`
          table keep their names — they are wire and schema identifiers with other systems on the
          far end, and renaming them would buy a tidier grep for the cost of a migration. */}
      <DropCard
        source="facebook"
        icon={Users}
        title="Friends"
        subtitle="A friends export — Excel, CSV or JSON"
        accept={UPLOAD_ACCEPT}
        onFile={(file) => setPicked({ source: "facebook", file })}
      />
    </div>
  );
}

function DropCard({
  icon: Icon,
  title,
  subtitle,
  accept,
  onFile,
}: {
  source: ImportSource;
  icon: typeof Building2;
  title: string;
  subtitle: string;
  accept: readonly string[];
  onFile: (file: File) => void;
}) {
  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="font-medium">{title}</p>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <UploadPanel
          accept={accept}
          file={null}
          onChange={(f) => f && onFile(f)}
          title="Drop a file"
          hint="or browse"
          className="min-h-[11rem]"
        />
      </CardContent>
    </Card>
  );
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
 * Where the import's matching run can be watched.
 *
 * The row that says "Processing" has to be clickable, and for two reasons. The obvious one is
 * that a page which tells you something is happening and gives you no way to go and look at it
 * is a dead end. The other is structural: the run page's progress poll is *what completes a run*
 * (there is no callback — the API only learns the workflow has finished by counting unstamped
 * rows), so an unreachable run is also an uncompletable one. Before this link, an import whose
 * uploader closed the tab stayed "Processing" forever, and the only cure was to already know the
 * URL.
 *
 * Null for an import made by the internal matcher: it opened no run, so there is nothing to link
 * to, and its status was final before the response returned.
 */
const runCell = (row: UploadSessionRow) => {
  if (!row.comparison_id) return <span className="text-muted-foreground">—</span>;

  return (
    <Link
      href={`/comparisons/${row.comparison_id}`}
      className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
    >
      View run
      <ArrowUpRight className="h-3.5 w-3.5" />
    </Link>
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

function SessionsList() {
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
    { key: "comparison_id", header: "Run", render: (r) => runCell(r) },
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
        emptyText="Drop a company or friends export above (.xlsx, .csv or .json) to get started."
      />
    </div>
  );
}
