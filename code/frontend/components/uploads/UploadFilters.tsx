"use client";

import * as React from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type UploadFilterState = {
  search: string;
  /** "all" | "company" | "facebook" */
  type: string;
  dateFrom: string;
  dateTo: string;
};

export const EMPTY_FILTERS: UploadFilterState = { search: "", type: "all", dateFrom: "", dateTo: "" };

const isDirty = (f: UploadFilterState) =>
  f.search !== "" || f.type !== "all" || f.dateFrom !== "" || f.dateTo !== "";

/** Search box + type / date-range filters shared by the upload sessions and history tables. */
export function UploadFilters({
  value,
  onChange,
}: {
  value: UploadFilterState;
  onChange: (v: UploadFilterState) => void;
}) {
  const set = (patch: Partial<UploadFilterState>) => onChange({ ...value, ...patch });

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-[14rem] flex-1">
        <Label className="text-xs">Search</Label>
        <div className="relative mt-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={value.search}
            onChange={(e) => set({ search: e.target.value })}
            placeholder="name, relationship owner, session id…"
            className="pl-9"
            aria-label="Search uploads"
          />
        </div>
      </div>

      <div className="w-40">
        <Label className="text-xs">Type</Label>
        <Select value={value.type} onValueChange={(v) => set({ type: v })}>
          <SelectTrigger className="mt-1">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="company">Company</SelectItem>
            <SelectItem value="facebook">Facebook</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="w-40">
        <Label htmlFor="date-from" className="text-xs">
          From
        </Label>
        <Input
          id="date-from"
          type="date"
          value={value.dateFrom}
          onChange={(e) => set({ dateFrom: e.target.value })}
          className="mt-1"
        />
      </div>

      <div className="w-40">
        <Label htmlFor="date-to" className="text-xs">
          To
        </Label>
        <Input
          id="date-to"
          type="date"
          value={value.dateTo}
          onChange={(e) => set({ dateTo: e.target.value })}
          className="mt-1"
        />
      </div>

      {isDirty(value) && (
        <Button variant="ghost" onClick={() => onChange(EMPTY_FILTERS)}>
          <X className="h-4 w-4" /> Clear
        </Button>
      )}
    </div>
  );
}

/**
 * Map the toolbar state to API query params. `typeKey` differs per table
 * (upload sessions filter on `uploadType`, history on `sourceType`).
 * `dateTo` is bumped to end-of-day so an inclusive day range matches ISO timestamps.
 */
export function toUploadParams(
  f: UploadFilterState,
  typeKey: "uploadType" | "sourceType"
): Record<string, string> {
  const params: Record<string, string> = {};
  if (f.search.trim()) params.search = f.search.trim();
  if (f.type !== "all") params[typeKey] = f.type;
  if (f.dateFrom) params.dateFrom = f.dateFrom;
  if (f.dateTo) params.dateTo = `${f.dateTo}T23:59:59.999Z`;
  return params;
}
