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

export function ResultsView({
  results,
  meanConfidence,
}: {
  results: ComparisonResultRow[];
  meanConfidence: number;
}) {
  const [q, setQ] = React.useState("");

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
    if (!needle) return results;
    return results.filter((r) =>
      [r.fb_name, r.person_name_en, r.person_name_th].some((v) => (v ?? "").toLowerCase().includes(needle))
    );
  }, [results, q]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Matches" value={results.length.toLocaleString()} />
        <Stat label="Mean confidence" value={`${(meanConfidence * 100).toFixed(0)}%`} className="text-primary" />
        <Stat label="Lowest" value={`${(min * 100).toFixed(0)}%`} />
        <Stat label="Highest" value={`${(max * 100).toFixed(0)}%`} />
      </div>

      <Card>
        <CardContent className="p-6">
          <p className="mb-4 text-sm font-medium text-muted-foreground">Confidence distribution</p>
          <ConfidenceChart data={histogram} />
        </CardContent>
      </Card>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search names…" className="pl-9" aria-label="Search results" />
      </div>

      <div className="overflow-hidden rounded-xl border">
        <ScrollArea className="max-h-[28rem]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Facebook name</TableHead>
                <TableHead>Company name (EN)</TableHead>
                <TableHead>Company name (TH)</TableHead>
                <TableHead className="text-right">Confidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                    No matches.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.slice(0, MAX_ROWS).map((r) => (
                  <TableRow key={r.uuid}>
                    <TableCell className="font-medium">{r.fb_name ?? "—"}</TableCell>
                    <TableCell>{r.person_name_en ?? "—"}</TableCell>
                    <TableCell>{r.person_name_th ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <ConfidenceBadge score={Number(r.matching_score) || 0} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
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
