"use client";

import * as React from "react";
import { Search } from "lucide-react";
import type { ComparisonResultRow } from "@extensions/contract";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfidenceBadge } from "@/components/confidence/ConfidenceBadge";
import { ConfidenceChart } from "@/components/confidence/ConfidenceChart";

const MAX_ROWS = 300;

type EnrichedRow = ComparisonResultRow & { _extra: Record<string, unknown> };

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={`font-display text-2xl font-bold tabular-nums ${className ?? ""}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

const cell = (v: unknown): string => (v === null || v === undefined || v === "" ? "—" : String(v));

export function ResultsView({
  results,
  meanConfidence,
  selectedCompany,
}: {
  results: ComparisonResultRow[];
  meanConfidence: number;
  selectedCompany?: string | null;
}) {
  const [q, setQ] = React.useState("");

  // Parse each row's `extra` JSON once, and collect the union of extra keys so any
  // additional fields the matcher returned become their own columns.
  const { rows, extraKeys } = React.useMemo(() => {
    const keys = new Set<string>();
    const rows: EnrichedRow[] = results.map((r) => {
      let extra: Record<string, unknown> = {};
      if (r.extra) {
        try {
          const parsed = JSON.parse(r.extra);
          if (parsed && typeof parsed === "object") extra = parsed as Record<string, unknown>;
        } catch {
          /* ignore malformed extra */
        }
      }
      for (const k of Object.keys(extra)) keys.add(k);
      return { ...r, _extra: extra };
    });
    return { rows, extraKeys: Array.from(keys).sort() };
  }, [results]);

  const { min, max, histogram } = React.useMemo(() => {
    const bins = Array(10).fill(0) as number[];
    let mn = Infinity;
    let mx = -Infinity;
    for (const r of results) {
      const s = Number(r.matching_score);
      if (!Number.isFinite(s)) continue;
      mn = Math.min(mn, s);
      mx = Math.max(mx, s);
      bins[Math.min(Math.floor(s * 10), 9)]++;
    }
    return { min: mn === Infinity ? 0 : mn, max: mx === -Infinity ? 0 : mx, histogram: bins };
  }, [results]);

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) =>
      [r.upload_name, r.fb_name, r.person_name_en, r.person_name_th, selectedCompany].some((v) =>
        (v ?? "").toLowerCase().includes(needle)
      )
    );
  }, [rows, q, selectedCompany]);

  const colCount = 6 + extraKeys.length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Matches" value={results.length.toLocaleString()} />
        <Stat label="Mean similarity" value={`${(meanConfidence * 100).toFixed(0)}%`} className="text-primary" />
        <Stat label="Lowest" value={`${(min * 100).toFixed(0)}%`} />
        <Stat label="Highest" value={`${(max * 100).toFixed(0)}%`} />
      </div>

      {selectedCompany && (
        <p className="text-sm text-muted-foreground">
          Uploaders with a potential connection to people at{" "}
          <span className="font-medium text-foreground">{selectedCompany}</span>.
        </p>
      )}

      <Card>
        <CardContent className="p-6">
          <p className="mb-4 text-sm font-medium text-muted-foreground">Similarity distribution</p>
          <ConfidenceChart data={histogram} />
        </CardContent>
      </Card>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search names…"
          className="pl-9"
          aria-label="Search results"
        />
      </div>

      <div className="overflow-hidden rounded-xl border">
        <ScrollArea className="max-h-[28rem]">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Upload name</TableHead>
                  <TableHead>Facebook match</TableHead>
                  <TableHead>Company name</TableHead>
                  <TableHead>English name</TableHead>
                  <TableHead>Thai name</TableHead>
                  {extraKeys.map((k) => (
                    <TableHead key={k} className="capitalize">
                      {k.replace(/_/g, " ")}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Similarity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={colCount} className="h-24 text-center text-muted-foreground">
                      No matches.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.slice(0, MAX_ROWS).map((r) => (
                    <TableRow key={r.uuid}>
                      <TableCell className="font-medium">{cell(r.upload_name)}</TableCell>
                      <TableCell>{cell(r.fb_name)}</TableCell>
                      <TableCell>{cell(selectedCompany)}</TableCell>
                      <TableCell>{cell(r.person_name_en)}</TableCell>
                      <TableCell>{cell(r.person_name_th)}</TableCell>
                      {extraKeys.map((k) => (
                        <TableCell key={k}>{cell(r._extra[k])}</TableCell>
                      ))}
                      <TableCell className="text-right">
                        <ConfidenceBadge score={Number(r.matching_score) || 0} />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </ScrollArea>
      </div>
      {filtered.length > MAX_ROWS && (
        <p className="text-center text-xs text-muted-foreground">
          Showing first {MAX_ROWS} of {filtered.length.toLocaleString()} — refine your search to see more.
        </p>
      )}
    </div>
  );
}
