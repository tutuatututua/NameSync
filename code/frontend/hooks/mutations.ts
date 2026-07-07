"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { CreateHistoryBody, SourceType } from "@extensions/contract";
import { api, ApiError } from "@/lib/api/client";
import { qk } from "./queryKeys";

const errMsg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

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

export function useSendWebhook() {
  return useMutation({
    mutationFn: (id: string) => api.comparisons.sendWebhook(id),
    onError: (e) => toast.error(errMsg(e, "Failed to send data to the processing service")),
  });
}

export function useTriggerComparison() {
  return useMutation({
    mutationFn: (id: string) => api.comparisons.trigger(id),
    onError: (e) => toast.error(errMsg(e, "Failed to start the comparison")),
  });
}

/** Start a comparison against one selected company (no file upload). */
export function useCompareByCompany() {
  return useMutation({
    mutationFn: (companyName: string) => api.comparisons.compareByCompany(companyName),
    onError: (e) => toast.error(errMsg(e, "Failed to start the comparison")),
  });
}

/** Reverse an upload session — hard-deletes the rows it imported. */
export function useRollbackSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.uploadSessions.rollback(id),
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success("Upload session rolled back");
    },
    onError: (e) => toast.error(errMsg(e, "Failed to roll back")),
  });
}

export function useSaveToHistory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateHistoryBody) => api.history.create(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.historyList() });
      toast.success("Saved to history");
    },
    onError: (e) => toast.error(errMsg(e, "Failed to save to history")),
  });
}

export function useDeleteHistory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.history.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.historyList() });
      toast.success("Comparison deleted");
    },
    onError: (e) => toast.error(errMsg(e, "Failed to delete")),
  });
}

export function useCloneHistory() {
  return useMutation({
    mutationFn: (id: string) => api.history.clone(id),
    onError: (e) => toast.error(errMsg(e, "Failed to clone session")),
  });
}

export function useDeleteCompanyRecord() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (uuid: string) => api.comparisons.deleteCompanyRecord(uuid),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.companyCount() });
      qc.invalidateQueries({ queryKey: ["all-company"] });
      toast.success("Record deleted");
    },
    onError: (e) => toast.error(errMsg(e, "Failed to delete record")),
  });
}

export function useDeleteFacebookRecord() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (uuid: string) => api.comparisons.deleteFacebookRecord(uuid),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.facebookCount() });
      qc.invalidateQueries({ queryKey: ["all-facebook"] });
      toast.success("Record deleted");
    },
    onError: (e) => toast.error(errMsg(e, "Failed to delete record")),
  });
}

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
