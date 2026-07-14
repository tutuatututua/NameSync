"use client";

import * as React from "react";
import { Plus, X, SlidersHorizontal } from "lucide-react";
import type { DbFilter, DbSort, DbTable, FilterOperator } from "@extensions/contract";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * The visual query builder: column + operator + value, stacked. It edits a *draft* and
 * only calls onApply when you press Apply, so the grid doesn't refetch on every keystroke.
 *
 * Reset it between tables by keying it on the table name — a filter on `friend_name`
 * is meaningless once you switch to `upload`.
 */

export interface QuerySpec {
  filters: DbFilter[];
  sort?: DbSort;
}

const OPERATORS: { value: FilterOperator; label: string }[] = [
  { value: "eq", label: "equals" },
  { value: "neq", label: "is not" },
  { value: "contains", label: "contains" },
  { value: "gt", label: "greater than" },
  { value: "gte", label: "at least" },
  { value: "lt", label: "less than" },
  { value: "lte", label: "at most" },
  { value: "in", label: "is one of" },
  { value: "is_null", label: "is empty" },
  { value: "is_not_null", label: "is not empty" },
];

/** These operators are the whole condition — there is nothing to type. */
const NO_VALUE: FilterOperator[] = ["is_null", "is_not_null"];

const NONE = "__none__";

export function FilterBar({
  table,
  value,
  onApply,
}: {
  table: DbTable;
  value: QuerySpec;
  onApply: (spec: QuerySpec) => void;
}) {
  const [filters, setFilters] = React.useState<DbFilter[]>(value.filters);
  const [sort, setSort] = React.useState<DbSort | undefined>(value.sort);

  const firstColumn = table.columns[0]?.name ?? "";

  const addFilter = () => setFilters((f) => [...f, { column: firstColumn, op: "eq", value: "" }]);
  const removeFilter = (i: number) => setFilters((f) => f.filter((_, idx) => idx !== i));
  const patch = (i: number, next: Partial<DbFilter>) =>
    setFilters((f) => f.map((x, idx) => (idx === i ? { ...x, ...next } : x)));

  const apply = () => {
    // "is one of" takes a comma-separated list; everything else is a single value. Drop
    // filters the user started but never filled in rather than sending an empty match.
    const cleaned = filters
      .filter((f) => NO_VALUE.includes(f.op) || String(f.value ?? "").trim() !== "")
      .map((f) => {
        if (NO_VALUE.includes(f.op)) return { column: f.column, op: f.op };
        if (f.op === "in") {
          return {
            column: f.column,
            op: f.op,
            value: String(f.value ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          };
        }
        return f;
      });
    onApply({ filters: cleaned, sort });
  };

  const clear = () => {
    setFilters([]);
    setSort(undefined);
    onApply({ filters: [], sort: undefined });
  };

  const dirty = filters.length > 0 || sort !== undefined;

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <SlidersHorizontal className="h-3.5 w-3.5" />
        Filters
      </div>

      {filters.map((f, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Select value={f.column} onValueChange={(v) => patch(i, { column: v })}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {table.columns.map((c) => (
                <SelectItem key={c.name} value={c.name}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={f.op} onValueChange={(v) => patch(i, { op: v as FilterOperator })}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OPERATORS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {!NO_VALUE.includes(f.op) && (
            <Input
              value={String(f.value ?? "")}
              onChange={(e) => patch(i, { value: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && apply()}
              placeholder={f.op === "in" ? "a, b, c" : "value"}
              className="w-52"
              aria-label="Filter value"
            />
          )}

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => removeFilter(i)}
            aria-label="Remove filter"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}

      <div className="flex flex-wrap items-end gap-3">
        <Button variant="outline" size="sm" onClick={addFilter}>
          <Plus className="h-4 w-4" /> Add filter
        </Button>

        <div className="w-44">
          <Label className="text-xs">Sort by</Label>
          <Select
            value={sort?.column ?? ""}
            onValueChange={(v) =>
              setSort(v === NONE ? undefined : { column: v, direction: sort?.direction ?? "asc" })
            }
          >
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Default</SelectItem>
              {table.columns.map((c) => (
                <SelectItem key={c.name} value={c.name}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {sort && (
          <div className="w-32">
            <Label className="text-xs">Direction</Label>
            <Select
              value={sort.direction}
              onValueChange={(v) => setSort({ column: sort.column, direction: v as "asc" | "desc" })}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asc">Ascending</SelectItem>
                <SelectItem value="desc">Descending</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="ml-auto flex gap-2">
          {dirty && (
            <Button variant="ghost" size="sm" onClick={clear}>
              Clear
            </Button>
          )}
          <Button size="sm" onClick={apply}>
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}
