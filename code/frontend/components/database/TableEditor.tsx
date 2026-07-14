"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, Pencil, Table2, Trash2 } from "lucide-react";
import type { DbColumn, DbRow, DbTable, TableQueryBody } from "@extensions/contract";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmButton } from "@/components/confirm-button";
import { ImportDialog } from "@/components/upload/ImportDialog";
import { DataManager, type Column } from "@/components/data-table/DataManager";
import { FilterBar, type QuerySpec } from "@/components/database/FilterBar";
import { RowFormDialog } from "@/components/database/RowFormDialog";
import { useDbRows, useDbTables } from "@/hooks/queries";
import { useClearData, useDeleteRow, useInsertRow, useUpdateRow } from "@/hooks/mutations";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The row editor. Everything it knows about the schema comes from GET /api/db/tables —
 * there is no table or column named in this file, so the registry on the server is the
 * only place the shape is defined. That extends to the Import / Clear-all controls: the
 * server says which import feeds a table (`importSource`) and this renders accordingly.
 */

const LIMIT = 20;

/** Render a cell according to its declared type — a jsonb column would otherwise
 *  stringify to "[object Object]". */
function Cell({ col, row }: { col: DbColumn; row: DbRow }) {
  const v = row[col.name];
  if (v === null || v === undefined) return <span className="text-muted-foreground">—</span>;

  if (col.type === "json") {
    return <code className="text-xs text-muted-foreground">{JSON.stringify(v)}</code>;
  }
  if (col.type === "boolean") {
    return <Badge variant={v ? "success" : "outline"}>{String(v)}</Badge>;
  }
  if (col.type === "timestamp") {
    return (
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        {formatDate(String(v))}
      </span>
    );
  }
  if (col.pk) {
    return <span className="font-mono text-xs text-muted-foreground">{String(v)}</span>;
  }
  return (
    <span className="block max-w-[16rem] truncate" title={String(v)}>
      {String(v)}
    </span>
  );
}

export function TableEditor() {
  const tablesQ = useDbTables();
  const router = useRouter();
  const params = useSearchParams();
  const tables = React.useMemo(() => tablesQ.data?.tables ?? [], [tablesQ.data]);

  // The selected table lives in the URL, so /database?table=company_contact is a real
  // link — the dashboard's stat cards and any bookmark land on the right table.
  const requested = params.get("table");
  const table: DbTable | null = tables.find((t) => t.name === requested) ?? tables[0] ?? null;

  const select = (name: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("table", name);
    router.replace(`?${next.toString()}`, { scroll: false });
  };

  if (tablesQ.isLoading) {
    return <Skeleton className="h-64 w-full rounded-lg" />;
  }

  return (
    <div className="flex flex-col gap-6 md:flex-row">
      {/* Same active treatment as the app sidebar — filled surface plus a brand rule on the
          leading edge — so "where am I" looks the same at both levels of navigation. */}
      <nav className="shrink-0 space-y-0.5 md:w-52" aria-label="Tables">
        {tables.map((t) => {
          const active = t.name === table?.name;
          return (
            <button
              key={t.name}
              onClick={() => select(t.name)}
              aria-current={active ? "true" : undefined}
              className={cn(
                "group relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm font-medium",
                "transition-colors duration-fast ease-swift",
                "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                active
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary transition-opacity duration-fast",
                  active ? "opacity-100" : "opacity-0"
                )}
              />
              <Table2
                className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-muted-foreground")}
              />
              <span className="min-w-0 flex-1 truncate">{t.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="min-w-0 flex-1">
        {table ? <TableGrid key={table.name} table={table} /> : <p>No tables available.</p>}
      </div>
    </div>
  );
}

/** Keyed on the table name by the parent, so page/filters reset when you switch tables. */
function TableGrid({ table }: { table: DbTable }) {
  const [page, setPage] = React.useState(1);
  const [spec, setSpec] = React.useState<QuerySpec>({ filters: [] });
  const [editing, setEditing] = React.useState<DbRow | null>(null);
  const [formOpen, setFormOpen] = React.useState(false);

  const body: TableQueryBody = React.useMemo(
    () => ({ page, limit: LIMIT, filters: spec.filters, sort: spec.sort }),
    [page, spec]
  );

  const rowsQ = useDbRows(table.name, body);
  const insert = useInsertRow(table.name);
  const update = useUpdateRow(table.name);
  const remove = useDeleteRow(table.name);

  const pk = table.columns.find((c) => c.pk)?.name ?? "id";

  const columns: Column<DbRow>[] = [
    ...table.columns.map((c) => ({
      key: c.name,
      header: c.label,
      render: (row: DbRow) => <Cell col={c} row={row} />,
    })),
    {
      key: "__edit",
      header: "",
      className: "text-right",
      render: (row) => (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Edit row"
          onClick={() => {
            setEditing(row);
            setFormOpen(true);
          }}
          className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Pencil className="h-4 w-4" />
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 space-y-0.5">
          <h2 className="font-display text-lg font-semibold tracking-tight">{table.label}</h2>
          <p className="text-sm text-muted-foreground">
            {table.description}{" "}
            <code className="ml-0.5 rounded border bg-muted px-1 py-0.5 font-mono text-xs">
              {table.name}
            </code>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {table.importSource && <ImportActions table={table} source={table.importSource} />}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="h-4 w-4" /> Insert row
          </Button>
        </div>
      </div>

      <FilterBar
        table={table}
        value={spec}
        onApply={(next) => {
          setSpec(next);
          setPage(1); // a new filter invalidates whatever page you were on
        }}
      />

      {/* No overflow wrapper here — DataManager's table scrolls inside its own border.
          Nesting a second scroll container just produced two scrollbars. */}
      <DataManager<DbRow>
        rows={rowsQ.data?.data ?? []}
        columns={columns}
        getRowId={(r) => String(r[pk])}
        total={rowsQ.data?.pagination.total ?? 0}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        isLoading={rowsQ.isLoading}
        isFetching={rowsQ.isFetching}
        // The registry decides the columns here, and there can be a dozen — this is the
        // table that has to size to its content and scroll.
        fitContent
        emptyTitle="No rows match"
        emptyText="Nothing in this table matches the current filters. Clear them to see everything."
        onDeleteRow={(id) => remove.mutateAsync(id)}
        isDeleting={remove.isPending}
      />

      <RowFormDialog
        table={table}
        row={editing}
        open={formOpen}
        onOpenChange={setFormOpen}
        isPending={insert.isPending || update.isPending}
        onSubmit={(values) =>
          editing
            ? update.mutateAsync({ id: String(editing[pk]), values })
            : insert.mutateAsync(values)
        }
      />
    </div>
  );
}

/**
 * Import / Clear-all for the tables an import feeds. Its own component so the
 * `useClearData` hook is only ever called for a table that actually has a source —
 * hooks can't be called conditionally.
 */
function ImportActions({ table, source }: { table: DbTable; source: "company" | "facebook" }) {
  const clear = useClearData(source);

  return (
    <>
      <ImportDialog source={source} />
      <ConfirmButton
        variant="outline"
        size="sm"
        title={`Clear all ${table.label.toLowerCase()}?`}
        description={`This permanently deletes every row in ${table.label.toLowerCase()} and its upload history.`}
        confirmLabel="Clear all"
        isLoading={clear.isPending}
        onConfirm={() => clear.mutateAsync()}
      >
        <Trash2 className="h-4 w-4" /> Clear all
      </ConfirmButton>
    </>
  );
}
