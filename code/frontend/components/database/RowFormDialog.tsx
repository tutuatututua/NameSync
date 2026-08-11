"use client";

import * as React from "react";
import type { DbColumn, DbRow, DbTable } from "@extensions/contract";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { LoadingButton } from "@/components/loading-button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Insert/edit a row. The form is generated from the server's column metadata — the
 * client has no hardcoded knowledge of any table, so adding a column to the registry
 * makes it appear here with no frontend change.
 *
 * Values are sent as the strings the user typed; the server coerces and validates them
 * against the real column type (api/src/models/table-editor.model.ts). Doing the
 * coercion in one place, server-side, means the browser can't talk it into a bad value.
 */

/** Radix Select cannot hold an empty value, so NULL needs a stand-in. */
const NONE = "__none__";

const toInput = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  return String(v);
};

interface Props {
  table: DbTable;
  /** The row being edited, or null to insert a new one. */
  row: DbRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: DbRow) => Promise<unknown>;
  isPending: boolean;
}

export function RowFormDialog({ table, row, open, onOpenChange, onSubmit, isPending }: Props) {
  const isEdit = row !== null;
  const editable = React.useMemo(() => table.columns.filter((c) => c.editable), [table]);

  const initial = React.useMemo(() => {
    const v: Record<string, string> = {};
    for (const c of editable) v[c.name] = row ? toInput(row[c.name]) : "";
    return v;
  }, [editable, row]);

  const [values, setValues] = React.useState<Record<string, string>>(initial);
  // Re-seed whenever the dialog is opened on a different row (or a different table).
  React.useEffect(() => setValues(initial), [initial]);

  const set = (name: string, v: string) => setValues((prev) => ({ ...prev, [name]: v }));

  const missing = editable.filter((c) => c.required && !values[c.name]?.trim());
  const filledCount = editable.filter((c) => values[c.name]?.trim()).length;
  const canSubmit = missing.length === 0 && (isEdit || filledCount > 0) && !isPending;

  async function submit() {
    const payload: DbRow = {};
    for (const c of editable) {
      const raw = values[c.name] ?? "";
      // On insert, an untouched field is omitted entirely so the column's database
      // default applies. On edit, clearing a field means "set this to NULL".
      if (!isEdit && raw === "") continue;
      payload[c.name] = raw === "" ? null : raw;
    }
    // Close only on success. A rejected save already raises a toast carrying the server's
    // message ("upload_id" is 25, but no row with that id exists in "upload"), and leaving
    // the dialog open is what makes that message useful — the typed values are still there
    // to correct. Swallowing the rejection here is deliberate: without the catch it escapes
    // as an unhandled promise rejection, since the toast is raised by the mutation, not by
    // this await.
    try {
      await onSubmit(payload);
    } catch {
      return;
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit row" : "New row"} in {table.label.toLowerCase()}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Clearing a field sets it to NULL. Generated and database-managed columns aren't shown."
              : "Fields left blank take their database default."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {editable.map((col) => (
            <Field key={col.name} col={col} value={values[col.name] ?? ""} onChange={(v) => set(col.name, v)} />
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <LoadingButton variant="gradient" isLoading={isPending} disabled={!canSubmit} onClick={submit}>
            {isEdit ? "Save changes" : "Add row"}
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  col,
  value,
  onChange,
}: {
  col: DbColumn;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = `field-${col.name}`;
  const label = (
    <Label htmlFor={id} className="text-xs">
      {col.label}
      {col.required && <span className="text-destructive"> *</span>}
      <span className="ml-1.5 font-normal text-muted-foreground">
        {col.type}
        {col.nullable ? "" : " · not null"}
      </span>
    </Label>
  );

  // A fixed set of values (a CHECK constraint, or a boolean) — a dropdown, not free text.
  const options = col.enumValues ?? (col.type === "boolean" ? ["true", "false"] : null);

  return (
    <div className="space-y-1.5">
      {label}
      {options ? (
        <Select value={value} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
          <SelectTrigger id={id}>
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            {col.nullable && <SelectItem value={NONE}>—</SelectItem>}
            {options.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : col.type === "json" ? (
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          placeholder='{ "key": "value" }'
          className="font-mono text-xs"
        />
      ) : (
        <Input
          id={id}
          type={col.type === "number" ? "number" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={col.type === "timestamp" ? "2026-07-13T09:30:00Z" : ""}
        />
      )}
    </div>
  );
}
