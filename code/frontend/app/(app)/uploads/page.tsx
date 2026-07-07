"use client";

import * as React from "react";
import { RotateCcw } from "lucide-react";
import type { UploadSessionRow, UploadHistoryRow } from "@extensions/contract";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { DataManager, type Column } from "@/components/data-table/DataManager";
import { IdCell } from "@/components/data-table/IdCell";
import { ConfirmButton } from "@/components/confirm-button";
import {
  UploadFilters,
  EMPTY_FILTERS,
  toUploadParams,
  type UploadFilterState,
} from "@/components/uploads/UploadFilters";
import { useUploadSessions, useUploadHistoryList } from "@/hooks/queries";
import { useRollbackSession } from "@/hooks/mutations";
import { formatDate } from "@/lib/format";

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
    "—"
  );

const statusBadge = (status: string | null) => {
  if (status === "rolled_back") return <Badge variant="destructive">Rolled back</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  return <Badge variant="outline">{status ?? "—"}</Badge>;
};

function SessionsTab() {
  const [filters, setFilters] = React.useState<UploadFilterState>(EMPTY_FILTERS);
  const [page, setPage] = React.useState(1);
  const search = useDebounced(filters.search);

  const params = React.useMemo(
    () => ({ page, limit: LIMIT, ...toUploadParams({ ...filters, search }, "uploadType") }),
    [page, filters.type, filters.dateFrom, filters.dateTo, search] // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Any filter change resets to page 1.
  React.useEffect(() => setPage(1), [filters.type, filters.dateFrom, filters.dateTo, search]);

  const q = useUploadSessions(params);
  const rollback = useRollbackSession();

  const columns: Column<UploadSessionRow>[] = [
    { key: "created_at", header: "Date", render: (r) => formatDate(r.created_at) },
    { key: "upload_type", header: "Type", render: (r) => typeBadge(r.upload_type) },
    { key: "name", header: "Name", render: (r) => r.name ?? "—" },
    { key: "uploaded_by", header: "Uploaded by", render: (r) => r.uploaded_by ?? "—" },
    {
      key: "records_uploaded",
      header: "Records",
      className: "text-right tabular-nums",
      render: (r) => (r.records_uploaded ?? 0).toLocaleString(),
    },
    {
      key: "duplicate_records",
      header: "Duplicates",
      className: "text-right tabular-nums",
      render: (r) => (r.duplicate_records ?? 0).toLocaleString(),
    },
    { key: "status", header: "Status", render: (r) => statusBadge(r.status) },
    { key: "id", header: "Session", render: (r) => <IdCell value={r.id} /> },
    {
      key: "actions",
      header: "",
      className: "text-right",
      render: (r) =>
        r.status === "rolled_back" ? (
          <span className="text-xs text-muted-foreground">Reversed</span>
        ) : (
          <ConfirmButton
            variant="outline"
            size="sm"
            title="Roll back this upload?"
            description="Permanently deletes exactly the rows this import added. Data already forwarded to the external service can't be recalled. This cannot be undone."
            confirmLabel="Roll back"
            isLoading={rollback.isPending}
            onConfirm={() => rollback.mutateAsync(r.id)}
          >
            <RotateCcw className="h-4 w-4" /> Roll back
          </ConfirmButton>
        ),
    },
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
        emptyText="No upload sessions yet."
      />
    </div>
  );
}

function HistoryTab() {
  const [filters, setFilters] = React.useState<UploadFilterState>(EMPTY_FILTERS);
  const [page, setPage] = React.useState(1);
  const search = useDebounced(filters.search);

  const params = React.useMemo(
    () => ({ page, limit: LIMIT, ...toUploadParams({ ...filters, search }, "sourceType") }),
    [page, filters.type, filters.dateFrom, filters.dateTo, search] // eslint-disable-line react-hooks/exhaustive-deps
  );
  React.useEffect(() => setPage(1), [filters.type, filters.dateFrom, filters.dateTo, search]);

  const q = useUploadHistoryList(params);

  const columns: Column<UploadHistoryRow>[] = [
    { key: "timestamp", header: "Date", render: (r) => formatDate(r.timestamp) },
    { key: "source_type", header: "Type", render: (r) => typeBadge(r.source_type) },
    { key: "user_upload", header: "Uploaded by", render: (r) => r.user_upload || "—" },
    {
      key: "rows_processed",
      header: "Records",
      className: "text-right tabular-nums",
      render: (r) => r.rows_processed.toLocaleString(),
    },
    {
      key: "duplicate_rows",
      header: "Duplicates",
      className: "text-right tabular-nums",
      render: (r) => r.duplicate_rows.toLocaleString(),
    },
    { key: "session_id", header: "Session", render: (r) => <IdCell value={r.session_id} /> },
  ];

  return (
    <div className="space-y-4">
      <UploadFilters value={filters} onChange={setFilters} />
      <DataManager<UploadHistoryRow>
        rows={q.data?.data ?? []}
        columns={columns}
        getRowId={(r) => r.id}
        total={q.data?.pagination.total ?? 0}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        isLoading={q.isLoading}
        emptyText="No upload history yet."
      />
    </div>
  );
}

export default function UploadsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold">Uploads</h1>
        <p className="text-muted-foreground">Import sessions you can roll back, and the full upload log.</p>
      </div>

      <Tabs defaultValue="sessions">
        <TabsList>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="sessions">
          <SessionsTab />
        </TabsContent>
        <TabsContent value="history">
          <HistoryTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
