"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { CreateSavedQueryBody, DbRow, RenameContactBody, SourceType } from "@extensions/contract";
import { api, ApiError } from "@/lib/api/client";
import { qk } from "./queryKeys";

const errMsg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

// ── Database console ────────────────────────────────────────────────────────
// Row writes invalidate the `db-rows` prefix, which refetches the grid whatever
// filters/page it happens to be on.

/**
 * The console is now the only way to add or remove a row, so a write here is what makes
 * the dashboard's record counts wrong. Invalidate them alongside the grid rather than
 * making the counts a special case of any one table — a write to *some* table is the
 * only signal we have, and a count refetch is a single cheap request.
 */
function useRowWriteInvalidation() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: qk.dbRowsAll() });
    qc.invalidateQueries({ queryKey: qk.companyCount() });
    qc.invalidateQueries({ queryKey: qk.facebookCount() });
  };
}

export function useInsertRow(table: string) {
  const invalidate = useRowWriteInvalidation();
  return useMutation({
    mutationFn: (values: DbRow) => api.db.insertRow(table, values),
    onSuccess: () => {
      invalidate();
      toast.success("Row added");
    },
    onError: (e) => toast.error(errMsg(e, "Failed to add the row")),
  });
}

export function useUpdateRow(table: string) {
  const invalidate = useRowWriteInvalidation();
  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: DbRow }) => api.db.updateRow(table, id, values),
    onSuccess: () => {
      invalidate();
      toast.success("Row updated");
    },
    onError: (e) => toast.error(errMsg(e, "Failed to update the row")),
  });
}

export function useDeleteRow(table: string) {
  const invalidate = useRowWriteInvalidation();
  return useMutation({
    mutationFn: (id: string) => api.db.deleteRow(table, id),
    onSuccess: () => {
      invalidate();
      toast.success("Row deleted");
    },
    onError: (e) => toast.error(errMsg(e, "Failed to delete the row")),
  });
}

/** Runs a read-only SELECT. A rejected query is shown inline, so no error toast here. */
export function useRunSql() {
  return useMutation({ mutationFn: (sql: string) => api.db.runSql(sql) });
}

export function useSaveQuery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSavedQueryBody) => api.db.saveQuery(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.savedQueries() });
      toast.success("Query saved");
    },
    onError: (e) => toast.error(errMsg(e, "Failed to save the query")),
  });
}

export function useDeleteSavedQuery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.db.deleteSavedQuery(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.savedQueries() });
      toast.success("Query deleted");
    },
    onError: (e) => toast.error(errMsg(e, "Failed to delete the query")),
  });
}

export function useUploadComparison() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (form: FormData) => api.comparisons.create(form),
    onSuccess: () => qc.invalidateQueries(),
    onError: (e) => toast.error(errMsg(e, "Upload failed")),
  });
}

/** Merge an optional company/facebook file (or neither), then run a comparison. */
export function useRunComparison() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (form: FormData) => api.comparisons.run(form),
    onSuccess: () => qc.invalidateQueries(),
    onError: (e) => toast.error(errMsg(e, "Failed to add data")),
  });
}

export function useMergeComparison() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, form }: { id: string; form: FormData }) => api.comparisons.merge(id, form),
    onSuccess: () => qc.invalidateQueries(),
    onError: (e) => toast.error(errMsg(e, "Merge failed")),
  });
}

export function useTriggerComparison() {
  return useMutation({
    mutationFn: (id: string) => api.comparisons.trigger(id),
    onError: (e) => toast.error(errMsg(e, "Failed to start the comparison")),
  });
}

/** Start one comparison against the selected companies (no file upload). */
export function useCompareByCompany() {
  return useMutation({
    mutationFn: (companyNames: string[]) => api.comparisons.compareByCompany(companyNames),
    onError: (e) => toast.error(errMsg(e, "Failed to start the comparison")),
  });
}

/** Undo an import — hard-deletes the rows it added. */
/**
 * Read a file and report what it would import — no write, no session, no row.
 * Errors surface inline in the import panel (a bad header is not a toast), so no onError.
 */
export function usePreviewUpload() {
  return useMutation({
    mutationFn: (form: FormData) => api.uploadSessions.preview(form),
  });
}

export function useRollbackSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.uploadSessions.rollback(id),
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success("Import undone");
    },
    onError: (e) => toast.error(errMsg(e, "Failed to undo the import")),
  });
}

/* There is no "save to history" any more. A run is stored the moment it happens, so asking
   the user to press a button to keep it was asking them to duplicate something the database
   already had — and the copy was what drifted out of shape. Renaming a run is the one thing
   that save flow really offered, and that is a field on the run. */

export function useRenameComparison() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.comparisons.rename(id, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.comparisons() });
      toast.success("Renamed");
    },
    onError: (e) => toast.error(errMsg(e, "Failed to rename")),
  });
}

/**
 * Rename a company contact (Feature 3) — someone left, or a director changed their name.
 *
 * Invalidates the Network views (a rename changes who a company connects to) and the DB console
 * grid + company list, since the same row is visible there. The server cleans the name, so the
 * cache is refetched rather than optimistically patched — the stored value may differ from what
 * was typed.
 */
export function useRenameContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ uuid, body }: { uuid: string; body: RenameContactBody }) =>
      api.comparisons.renameCompanyRecord(uuid, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.networkSearchAll() });
      qc.invalidateQueries({ queryKey: qk.networkOverviewAll() });
      qc.invalidateQueries({ queryKey: qk.dbRowsAll() });
      qc.invalidateQueries({ queryKey: qk.companies() });
      toast.success("Contact updated");
    },
    onError: (e) => toast.error(errMsg(e, "Failed to update the contact")),
  });
}

export function useDeleteComparison() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.comparisons.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.comparisons() });
      toast.success("Comparison deleted");
    },
    onError: (e) => toast.error(errMsg(e, "Failed to delete")),
  });
}

/** Wipes a whole source. Reached from the Database console's Clear-all, on the tables an
 *  import feeds (`importSource` in the server's table registry). */
export function useClearData(source: SourceType) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => (source === "company" ? api.comparisons.clearCompany() : api.comparisons.clearFacebook()),
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success(`All ${source} data cleared`);
    },
    onError: (e) => toast.error(errMsg(e, "Failed to clear data")),
  });
}
