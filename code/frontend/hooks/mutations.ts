"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  CompareBy,
  CreateSavedQueryBody,
  DbRow,
  RenameContactBody,
  RequestedScope,
  SourceType,
} from "@extensions/contract";
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

/**
 * Start one comparison over rows already on file — no upload, no import.
 *
 * ── IT INVALIDATES THE RUN LIST NOW, AND IT HAS TO ──
 *
 * It used to invalidate nothing, which was correct while every caller navigated straight to the new
 * run's page: the run list would be re-read on the way back. Scoped runs broke that assumption —
 * they are started from a company row, a roster row and an import row, and the reader stays where
 * they are — so without this, "Recent comparisons" would keep showing the list as it was before the
 * run they just started.
 *
 * The comparisons key only: this writes `comparison` and (for an unscoped run) `comparison_result`,
 * and a blanket `invalidateQueries()` would re-fetch every network tally behind a dialog that has
 * just closed. The run's own page fetches itself.
 */
export function useCompareByCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      companyNames,
      compareBy,
      sources,
      scope,
    }: {
      /** Which companies are in the run — null for every company on file. */
      companyNames: string[] | null;
      compareBy: CompareBy;
      /** Which friends are in the run — null for every source. */
      sources: string[] | null;
      /** WHICH ROWS — a company, a relationship owner or a past import. Omitted is the legacy
       *  whole-table / company-list run. */
      scope?: RequestedScope | null;
    }) => api.comparisons.compareByCompany(companyNames, compareBy, sources, scope),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.comparisonsAll() }),
    onError: (e) => toast.error(errMsg(e, "Failed to start the comparison")),
  });
}

/**
 * Add an import type, for good.
 *
 * Invalidates the list so the picker shows it immediately — and so a second tab that already had
 * the picker open gets it on its next read, which is the "persists for the next user" the feature
 * is for.
 */
export function useAddUploadSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (value: string) => api.uploadSources.create(value),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.uploadSources() }),
    onError: (e) => toast.error(errMsg(e, "Couldn't add that type")),
  });
}

/** Take a type out of the picker. Imports already filed under it keep it — there is no FK. */
export function useRemoveUploadSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (value: string) => api.uploadSources.remove(value),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.uploadSources() }),
    onError: (e) => toast.error(errMsg(e, "Couldn't remove that type")),
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
      qc.invalidateQueries({ queryKey: qk.comparisonsAll() });
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
      // The `*All` prefix, so every cached SEARCH is dropped and not merely the empty one. A rename
      // can move a company in or out of any query's results, and the picker now caches one entry
      // per search text.
      qc.invalidateQueries({ queryKey: qk.companiesAll() });
      toast.success("Contact updated");
    },
    onError: (e) => toast.error(errMsg(e, "Failed to update the contact")),
  });
}

/*
 * `useDeleteComparison` was removed on 2026-08-07 with the overflow menu it served. Runs are not
 * deletable from the app any more — the server refuses `DELETE /api/comparisons/:id` for every
 * account, and the reasoning is written where the refusal is (api/src/routes/comparisons.route.ts).
 * Nothing here should grow a replacement without that endpoint changing first.
 */

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
