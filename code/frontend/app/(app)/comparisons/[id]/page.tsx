"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfidenceChart } from "@/components/confidence/ConfidenceChart";
import { ConfidenceBadge } from "@/components/confidence/ConfidenceBadge";
import { useHistoryDetail } from "@/hooks/queries";
import { formatDate } from "@/lib/format";

interface SavedRow {
  fbName?: string;
  companyName?: string;
  confidence?: number;
  [k: string]: unknown;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="font-display text-2xl font-bold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

export default function ComparisonDetailPage() {
  const params = useParams<{ id: string }>();
  const id = String(params.id);
  const savedFlag = useSearchParams().get("saved");
  const { data, isLoading } = useHistoryDetail(id);

  if (isLoading) {
    return <Skeleton className="h-96 w-full rounded-xl" />;
  }
  if (!data) {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground">Comparison not found.</p>
        <Button asChild variant="outline">
          <Link href="/history">
            <ArrowLeft className="h-4 w-4" /> Back to history
          </Link>
        </Button>
      </div>
    );
  }

  const rows = (data.results as SavedRow[]) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="icon" aria-label="Back">
              <Link href="/history">
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>
            <h1 className="font-display text-2xl font-bold">{data.name}</h1>
          </div>
          <p className="ml-10 text-muted-foreground">
            {formatDate(data.date)} · {data.rowCount.toLocaleString()} rows
          </p>
        </div>
        <ConfidenceBadge score={data.meanConfidence} />
      </div>

      {savedFlag && (
        <div className="flex items-center gap-2 rounded-xl border border-confidence-high/30 bg-confidence-high/10 p-3 text-sm text-confidence-high">
          <CheckCircle2 className="h-4 w-4" /> Saved to history.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Rows" value={data.stats.totalRows.toLocaleString()} />
        <Stat label="Mean" value={`${(Number(data.stats.mean) * 100).toFixed(0)}%`} />
        <Stat label="Lowest" value={`${(Number(data.stats.minConfidence) * 100).toFixed(0)}%`} />
        <Stat label="Highest" value={`${(Number(data.stats.maxConfidence) * 100).toFixed(0)}%`} />
      </div>

      <Card>
        <CardContent className="p-6">
          <p className="mb-4 text-sm font-medium text-muted-foreground">Confidence distribution</p>
          <ConfidenceChart data={data.histogramData} />
        </CardContent>
      </Card>

      {rows.length > 0 && (
        <div className="overflow-hidden rounded-xl border">
          <ScrollArea className="max-h-[28rem]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Facebook name</TableHead>
                  <TableHead>Company name</TableHead>
                  <TableHead className="text-right">Confidence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.slice(0, 300).map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{r.fbName ?? "—"}</TableCell>
                    <TableCell>{r.companyName ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      {typeof r.confidence === "number" ? <ConfidenceBadge score={r.confidence} /> : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
