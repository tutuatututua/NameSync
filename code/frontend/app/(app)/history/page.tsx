"use client";

import Link from "next/link";
import { Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmButton } from "@/components/confirm-button";
import { ConfidenceBadge } from "@/components/confidence/ConfidenceBadge";
import { useHistoryList } from "@/hooks/queries";
import { useDeleteHistory } from "@/hooks/mutations";
import { formatDate } from "@/lib/format";

export default function HistoryPage() {
  const { data, isLoading } = useHistoryList();
  const del = useDeleteHistory();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold">History</h1>
        <p className="text-muted-foreground">Your saved comparisons.</p>
      </div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      ) : !data?.length ? (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground">
            No saved comparisons yet.{" "}
            <Link href="/compare" className="text-primary underline">
              Run one →
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {data.map((h) => (
            <Card key={h.id} className="transition-colors hover:border-primary/50">
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <Link href={`/comparisons/${h.id}`} className="min-w-0 flex-1">
                    <p className="truncate font-medium">{h.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {formatDate(h.date)} · {h.rowCount.toLocaleString()} rows
                    </p>
                    <div className="mt-3">
                      <ConfidenceBadge score={h.meanConfidence} />
                    </div>
                  </Link>
                  <ConfirmButton
                    variant="ghost"
                    size="icon"
                    aria-label="Delete comparison"
                    title="Delete this comparison?"
                    description="This cannot be undone."
                    confirmLabel="Delete"
                    isLoading={del.isPending}
                    onConfirm={() => del.mutateAsync(h.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </ConfirmButton>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
