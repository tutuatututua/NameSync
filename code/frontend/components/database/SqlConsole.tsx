"use client";

import * as React from "react";
import { Play, Save, Download, Trash2, AlertCircle, Info } from "lucide-react";
import type { SqlResult } from "@extensions/contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LoadingButton } from "@/components/loading-button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSavedQueries } from "@/hooks/queries";
import { useDeleteSavedQuery, useRunSql, useSaveQuery } from "@/hooks/mutations";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";

/**
 * The SQL editor. Read-only by construction — the server runs whatever you type inside a
 * READ ONLY transaction wrapped as a subquery, so a write is rejected rather than run
 * (api/src/services/sql-console.service.ts). The UI says so plainly rather than letting
 * someone discover it by having a DELETE silently fail.
 */

const PLACEHOLDER = `select c.company_name, c.person_name_en, u.uploaded_by
from company_contact c
join upload u on u.id = c.upload_id
order by c.id desc`;

/** RFC-4180-ish: quote a field and double any quotes inside it. */
function toCsv(columns: string[], rows: unknown[][]): string {
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\r\n");
}

function downloadCsv(result: SqlResult): void {
  const blob = new Blob([toCsv(result.columns, result.rows)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `query-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function SqlConsole() {
  const [sql, setSql] = React.useState("");
  const [result, setResult] = React.useState<SqlResult | null>(null);
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [saveName, setSaveName] = React.useState("");

  const run = useRunSql();
  const save = useSaveQuery();
  const del = useDeleteSavedQuery();
  const savedQ = useSavedQueries();

  const error = run.error instanceof ApiError ? run.error.message : run.error ? "Could not run that query" : null;

  async function execute() {
    if (!sql.trim()) return;
    try {
      setResult(await run.mutateAsync(sql));
    } catch {
      setResult(null); // the error is rendered inline from run.error
    }
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <div className="min-w-0 flex-1 space-y-4">
        <div className="space-y-2">
          <Textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void execute();
              }
            }}
            rows={8}
            spellCheck={false}
            placeholder={PLACEHOLDER}
            className="font-mono text-sm"
            aria-label="SQL query"
          />

          <div className="flex flex-wrap items-center gap-2">
            <LoadingButton variant="gradient" isLoading={run.isPending} disabled={!sql.trim()} onClick={execute}>
              <Play className="h-4 w-4" /> Run
            </LoadingButton>
            <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter</span>

            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" disabled={!sql.trim()} onClick={() => setSaveOpen(true)}>
                <Save className="h-4 w-4" /> Save
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!result || result.rows.length === 0}
                onClick={() => result && downloadCsv(result)}
              >
                <Download className="h-4 w-4" /> Export CSV
              </Button>
            </div>
          </div>

          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 shrink-0" />
            Read-only: SELECT queries only. Anything that would change data is rejected.
          </p>
        </div>

        {error && (
          <div className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0 translate-y-0.5" />
            <pre className="whitespace-pre-wrap font-mono text-xs">{error}</pre>
          </div>
        )}

        {result && !error && <Results result={result} />}
      </div>

      {/* Saved queries */}
      <aside className="shrink-0 space-y-2 lg:w-64">
        <h3 className="text-sm font-medium">Saved queries</h3>
        {savedQ.data?.length ? (
          <ul className="space-y-1">
            {savedQ.data
              .filter((q) => q.kind === "sql")
              .map((q) => (
                <li key={q.id} className="group flex items-center gap-1 rounded-lg hover:bg-muted">
                  <button
                    className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm"
                    title={q.sql_text ?? ""}
                    onClick={() => setSql(q.sql_text ?? "")}
                  >
                    {q.name}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${q.name}`}
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={() => del.mutate(q.id)}
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                  </Button>
                </li>
              ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing saved yet.</p>
        )}
      </aside>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save this query</DialogTitle>
            <DialogDescription>It&apos;ll appear in the list, ready to load and re-run.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="query-name" className="text-xs">
              Name
            </Label>
            <Input
              id="query-name"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="e.g. Contacts by uploader"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <LoadingButton
              variant="gradient"
              isLoading={save.isPending}
              disabled={!saveName.trim()}
              onClick={async () => {
                await save.mutateAsync({ name: saveName.trim(), kind: "sql", sql_text: sql });
                setSaveName("");
                setSaveOpen(false);
              }}
            >
              Save
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Results({ result }: { result: SqlResult }) {
  const { columns, rows, rowCount, truncated, elapsedMs } = result;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {rowCount.toLocaleString()} row{rowCount === 1 ? "" : "s"}
        </span>
        <span className="tabular-nums">{elapsedMs} ms</span>
        {truncated && (
          <span className="font-medium text-confidence-medium">
            Showing the first {rowCount.toLocaleString()} — add a LIMIT or narrow the query to see the rest.
          </span>
        )}
      </div>

      {/* The height cap belongs on the table's own scroll container — that's the scrollport
          the sticky header resolves against. TableHeader is sticky by default now, so the
          local `sticky top-0` this used to carry is gone. */}
      <div className="overflow-hidden rounded-lg border">
        <Table containerClassName="max-h-[28rem]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {columns.map((c, i) => (
                // Duplicate names are legitimate (`select *` across a join), so the index
                // is the only stable key here.
                <TableHead key={`${c}-${i}`} className="whitespace-nowrap font-mono text-xs">
                  {c}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={Math.max(columns.length, 1)} className="h-24 text-center text-muted-foreground">
                  No rows.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row, r) => (
                <TableRow key={r}>
                  {row.map((cell, c) => (
                    <TableCell key={c} className={cn("text-sm", cell === null && "text-muted-foreground")}>
                      {cell === null || cell === undefined ? (
                        "NULL"
                      ) : typeof cell === "object" ? (
                        <code className="text-xs">{JSON.stringify(cell)}</code>
                      ) : (
                        <span className="block max-w-[20rem] truncate" title={String(cell)}>
                          {String(cell)}
                        </span>
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
