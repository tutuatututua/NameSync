"use client";

import Link from "next/link";
import { Building2, Users, GitCompareArrows, ArrowRight, History } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfidenceBadge } from "@/components/confidence/ConfidenceBadge";
import { useCompanyCount, useFacebookCount, useHistoryList } from "@/hooks/queries";
import { formatDate } from "@/lib/format";

function StatCard({
  icon: Icon,
  label,
  value,
  loading,
  href,
}: {
  icon: typeof Building2;
  label: string;
  value: number | undefined;
  loading: boolean;
  href: string;
}) {
  return (
    <Link href={href}>
      <Card className="transition-colors hover:border-primary/50">
        <CardContent className="flex items-center gap-4 p-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Icon className="h-6 w-6" />
          </div>
          <div>
            {loading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <p className="font-display text-3xl font-bold tabular-nums">{(value ?? 0).toLocaleString()}</p>
            )}
            <p className="text-sm text-muted-foreground">{label}</p>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function DashboardPage() {
  const company = useCompanyCount();
  const facebook = useFacebookCount();
  const history = useHistoryList();

  return (
    <div className="space-y-8">
      <div className="relative overflow-hidden rounded-2xl bg-gradient-brand p-8 text-primary-foreground shadow-lg">
        <div className="relative z-10 max-w-xl">
          <h1 className="font-display text-3xl font-bold">Sync &amp; match names with confidence</h1>
          <p className="mt-2 text-primary-foreground/90">
            Import your company and Facebook data, then pick a company to find connected uploaders.
          </p>
          <Button asChild variant="secondary" className="mt-5">
            <Link href="/compare">
              <GitCompareArrows className="h-4 w-4" /> Compare <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
        <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-white/10 blur-2xl" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard icon={Building2} label="Company records" value={company.data} loading={company.isLoading} href="/data/company" />
        <StatCard icon={Users} label="Facebook records" value={facebook.data} loading={facebook.isLoading} href="/data/facebook" />
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold">Recent comparisons</h2>
          <Button asChild variant="ghost" size="sm">
            <Link href="/history">
              <History className="h-4 w-4" /> View all
            </Link>
          </Button>
        </div>
        {history.isLoading ? (
          <Skeleton className="h-24 w-full rounded-xl" />
        ) : !history.data?.length ? (
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground">
              No saved comparisons yet.{" "}
              <Link href="/compare" className="text-primary underline">
                Run your first →
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {history.data.slice(0, 5).map((h) => (
              <Link
                key={h.id}
                href={`/comparisons/${h.id}`}
                className="flex items-center justify-between rounded-xl border bg-card p-4 transition-colors hover:border-primary/50"
              >
                <div>
                  <p className="font-medium">{h.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {formatDate(h.date)} · {h.rowCount.toLocaleString()} rows
                  </p>
                </div>
                <ConfidenceBadge score={h.meanConfidence} />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
