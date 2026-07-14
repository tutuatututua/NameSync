"use client";

import * as React from "react";
import { Inbox, Trash2, ChevronLeft, ChevronRight } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { LoadingButton } from "@/components/loading-button";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => React.ReactNode;
  className?: string;
  /**
   * Pin this column to the right edge while the rest of the table scrolls under it.
   *
   * For the column that holds the row's action. A table wide enough to scroll will otherwise
   * push its own primary button off-screen, and you have to scroll sideways to find out that
   * "Undo" was there all along. Pinned, it's always where you'd reach for it.
   */
  stickyRight?: boolean;
}

/**
 * A pinned cell has to be opaque — the rows scroll *underneath* it — which means it also has
 * to reproduce the row's hover tint by hand, since a transparent cell would let the moving
 * content show through. The left hairline stands in for the edge the scroll would otherwise
 * blur away.
 */
const STICKY_CELL =
  "sticky right-0 z-10 border-l border-border bg-card transition-colors group-hover:bg-muted/50";

interface DataManagerProps<T> {
  rows: T[];
  columns: Column<T>[];
  getRowId: (row: T) => string;
  total: number;
  page: number;
  limit: number;
  onPageChange: (page: number) => void;
  isLoading?: boolean;
  /** True while a *subsequent* fetch is in flight (paging, filtering) — see below. */
  isFetching?: boolean;
  /**
   * Size the table to its content and let it scroll sideways, rather than fitting the
   * container.
   *
   * The Database console needs this: it renders whatever columns the registry exposes, and
   * at a dozen of them `w-full` squeezes until the headers wrap and every cell truncates.
   * A table with a known, modest column count does not — and shouldn't opt in, because
   * content-width means the last column (which is where the row's action lives) gets pushed
   * off the right edge for the sake of 50px it could just as well have compressed.
   */
  fitContent?: boolean;
  emptyTitle?: string;
  emptyText?: string;
  onDeleteRow?: (id: string) => Promise<unknown> | void;
  isDeleting?: boolean;
}

export function DataManager<T>({
  rows,
  columns,
  getRowId,
  total,
  page,
  limit,
  onPageChange,
  isLoading,
  isFetching,
  fitContent = false,
  emptyTitle = "Nothing here yet",
  emptyText = "No records to show.",
  onDeleteRow,
  isDeleting,
}: DataManagerProps<T>) {
  const [pending, setPending] = React.useState<string | null>(null);
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  // Skeletons only on the *first* load. Paging to the next page already has a table on
  // screen; tearing it down to grey bars and rebuilding it makes the page jump for no
  // information gain. Subsequent fetches just dim what's there.
  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="overflow-hidden rounded-lg border">
          <Table className={cn(fitContent && "min-w-max")}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {columns.map((c) => (
                  <TableHead key={c.key} className={c.className}>
                    {c.header}
                  </TableHead>
                ))}
                {onDeleteRow && <TableHead className="w-12" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={`sk-${i}`} className="hover:bg-transparent">
                  {columns.map((c) => (
                    <TableCell key={c.key}>
                      <Skeleton className="h-4 w-24" />
                    </TableCell>
                  ))}
                  {onDeleteRow && <TableCell />}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return <EmptyState icon={Inbox} title={emptyTitle} description={emptyText} />;
  }

  return (
    <div className="space-y-3">
      <div
        className={cn(
          "overflow-hidden rounded-lg border transition-opacity duration-fast",
          isFetching && "opacity-60"
        )}
      >
        <Table className={cn(fitContent && "min-w-max")}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {columns.map((c) => (
                <TableHead
                  key={c.key}
                  className={cn(
                    c.className,
                    // z-20: the pinned header cell sits at the intersection of a sticky row
                    // and a sticky column, so it has to outrank both.
                    c.stickyRight && "sticky right-0 z-20 border-l border-border bg-card"
                  )}
                >
                  {c.header}
                </TableHead>
              ))}
              {onDeleteRow && <TableHead className="w-12" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const id = getRowId(row);
              return (
                <TableRow key={id} className="group">
                  {columns.map((c) => (
                    <TableCell
                      key={c.key}
                      className={cn(c.className, c.stickyRight && STICKY_CELL)}
                    >
                      {c.render
                        ? c.render(row)
                        : String((row as Record<string, unknown>)[c.key] ?? "—")}
                    </TableCell>
                  ))}
                  {onDeleteRow && (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete row"
                        onClick={() => setPending(id)}
                        className="opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <span className="tabular-nums">
          {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
        </span>
        {totalPages > 1 && (
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="px-1 tabular-nums">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      <AlertDialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this record?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction asChild>
              <LoadingButton
                variant="destructive"
                isLoading={isDeleting}
                onClick={async (e) => {
                  e.preventDefault();
                  if (pending && onDeleteRow) await onDeleteRow(pending);
                  setPending(null);
                }}
              >
                Delete
              </LoadingButton>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
