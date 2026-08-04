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
import { ALL_SOURCES_LABEL } from "@extensions/contract";
import { useUploadSources } from "@/hooks/queries";

export type UploadFilterState = {
  search: string;
  /**
   * WHICH SIDE — "all" | "company" | "facebook", where "facebook" means friends of any source.
   * The value keeps its legacy spelling; the label on screen does not (see below).
   */
  type: string;
  /** WHERE the friends came from — "all" or an `upload_source` value. Independent of `type`. */
  source: string;
  dateFrom: string;
  dateTo: string;
};

export const EMPTY_FILTERS: UploadFilterState = {
  search: "",
  type: "all",
  source: "all",
  dateFrom: "",
  dateTo: "",
};

const isDirty = (f: UploadFilterState) =>
  f.search !== "" || f.type !== "all" || f.source !== "all" || f.dateFrom !== "" || f.dateTo !== "";

/** Sentinel for "no source filter". A Select cannot hold "" as a value, and "all" is already the
 *  vocabulary the type filter beside it uses. */
const ALL = "all";

/** Search box + type / date-range filters shared by the upload sessions and history tables. */
export function UploadFilters({
  value,
  onChange,
}: {
  value: UploadFilterState;
  onChange: (v: UploadFilterState) => void;
}) {
  const set = (patch: Partial<UploadFilterState>) => onChange({ ...value, ...patch });
  const sources = useUploadSources();

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

      {/*
        WHICH SIDE. Labelled "Friends" and not "Facebook", which is what it used to say and what
        the value is still spelled: the option filtered kind=social AND source='facebook', so a
        LinkedIn import appeared under neither option and was unreachable from this toolbar. It now
        means every friends import whatever its source, and Source beside it is what narrows.
      */}
      <div className="w-40">
        <Label className="text-xs">Data</Label>
        <Select value={value.type} onValueChange={(v) => set({ type: v })}>
          <SelectTrigger className="mt-1">
            <SelectValue placeholder="Everything" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everything</SelectItem>
            <SelectItem value="company">Company contacts</SelectItem>
            <SelectItem value="facebook">Friends</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/*
        WHERE the friends came from — the axis this whole change is about, and the one the uploads
        table had no way to filter on.

        Offered even when Data is "Company contacts", where it can only ever match nothing, rather
        than hidden or disabled. A control that appears and disappears as a neighbour changes costs
        the reader more than the impossible combination does — and the combination is recoverable in
        one click, where a vanished control has to be rediscovered.
      */}
      <div className="w-44">
        <Label className="text-xs">Source</Label>
        <Select value={value.source} onValueChange={(v) => set({ source: v })}>
          <SelectTrigger className="mt-1">
            <SelectValue placeholder="All sources" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{ALL_SOURCES_LABEL}</SelectItem>
            {(sources.data ?? []).map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
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
  // Its own param, not folded into `typeKey`: the two axes are independent now, and the server
  // applies them as separate WHEREs — "friends, from LinkedIn" is a real and useful pair.
  if (f.source !== ALL) params.source = f.source;
  if (f.dateFrom) params.dateFrom = f.dateFrom;
  if (f.dateTo) params.dateTo = `${f.dateTo}T23:59:59.999Z`;
  return params;
}
