"use client";

import * as React from "react";
import Link from "next/link";
import { GitCompareArrows, History, UploadCloud } from "lucide-react";
import {
  compareByLabel,
  sourceLabel,
  sourcesLabel,
  sourcesTooltip,
  type AuditEvent,
} from "@extensions/contract";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { SectionHeader } from "@/components/page-header";
import { useAuditActivity, useUploadSources } from "@/hooks/queries";
import { usePermissions } from "@/components/auth-provider";
import { formatCompanies, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The trail — every run and every import, interleaved, newest first.
 *
 * ── WHY ONE COLUMN AND NOT TWO LISTS ──
 *
 * An import and the run it opened are seconds apart, and the causation is only visible when they
 * are read in one sequence. Two lists side by side would put the reader in charge of interleaving
 * by timestamp, which is exactly the work the server has already done.
 *
 * ── WHAT THE ROWS DO AND DO NOT SAY ──
 *
 * These are the rows that exist NOW, not a log of everything that ever happened: a deleted run is
 * simply absent, and a rolled-back import survives as a row stamped `rolled_back`. That is stated
 * on the page, once, because a trail that quietly omits things is worse than no trail.
 *
 * `actor` is who started it: recorded on the run since 2026-08-04, and falling back to the uploader
 * of the import that opened it for runs predating that. Still null for a run started from the
 * Network page before the column existed — it renders as nothing rather than as a guess.
 */

const PAGE_SIZE = 20;

type KindFilter = "all" | "run" | "import";

const FILTERS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "run", label: "Runs" },
  { value: "import", label: "Imports" },
];

export function AuditTrail() {
  const [kind, setKind] = React.useState<KindFilter>("all");
  const [page, setPage] = React.useState(1);
  const { canWrite } = usePermissions();

  const query = useAuditActivity({
    page,
    limit: PAGE_SIZE,
    kind: kind === "all" ? undefined : kind,
  });

  // The pick-list, so a row's source chip reads the way the picker spells it ("LinkedIn", not
  // "Linkedin"). Reviewers may call this endpoint, so it works for them too.
  const sourceList = useUploadSources();
  const sourceLabels = React.useMemo(
    () => new Map((sourceList.data ?? []).map((s) => [s.value, s.label])),
    [sourceList.data]
  );

  const events = query.data?.data ?? [];
  const totalPages = query.data?.pagination.totalPages ?? 0;
  const total = query.data?.pagination.total ?? 0;

  function changeFilter(next: KindFilter) {
    setKind(next);
    // Page 3 of "everything" is not page 3 of "imports" — keeping the number would land the reader
    // somewhere arbitrary, or past the end.
    setPage(1);
  }

  return (
    <section className="space-y-4">
      <SectionHeader
        title="The trail"
        description={
          total > 0
            ? `${total.toLocaleString()} recorded ${total === 1 ? "event" : "events"}, newest first`
            : undefined
        }
        actions={
          <div className="flex gap-1 rounded-md border p-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => changeFilter(f.value)}
                aria-pressed={kind === f.value}
                className={cn(
                  "rounded px-2.5 py-1 text-xs font-medium transition-colors duration-fast",
                  "outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  kind === f.value
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        }
      />

      {query.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[64px] rounded-lg" />
          ))}
        </div>
      ) : events.length === 0 ? (
        <EmptyState
          icon={History}
          title={kind === "all" ? "Nothing has happened yet" : `No ${kind}s recorded`}
          description={
            kind !== "all"
              ? "Try “Everything” — the other kind of event may still be here."
              : canWrite
                ? "Import a friend list or some company data. Every import and every run it starts is recorded here."
                : "No imports or comparison runs have been recorded yet."
          }
        />
      ) : (
        <div
          // Dimmed rather than blanked while the next page loads — the rows on screen are still
          // true, and replacing them with skeletons on every page turn is a strobe.
          className={cn(
            "overflow-hidden rounded-lg border transition-opacity",
            query.isFetching && "opacity-60"
          )}
        >
          {events.map((event) => (
            <EventRow key={`${event.kind}-${event.id}`} event={event} sourceLabels={sourceLabels} />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || query.isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages || query.isFetching}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function EventRow({
  event,
  sourceLabels,
}: {
  event: AuditEvent;
  sourceLabels: ReadonlyMap<string, string>;
}) {
  const Icon = event.kind === "run" ? GitCompareArrows : UploadCloud;

  return (
    <div className="group relative flex items-start gap-3 border-b p-3.5 last:border-b-0 transition-colors hover:bg-muted/40 focus-within:bg-muted/40">
      <span
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground"
        aria-hidden
      >
        <Icon className="h-3.5 w-3.5" />
      </span>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <p className="min-w-0 truncate text-sm font-medium">{title(event)}</p>
          <StatusBadge status={event.status} />
        </div>

        <p className="text-xs text-muted-foreground">{subtitle(event)}</p>

        <div className="relative z-10 flex flex-wrap items-center gap-1.5 pt-0.5">
          {event.kind === "run" ? (
            <>
              <Badge variant="outline" className="font-normal">
                {compareByLabel(event.mode)}
              </Badge>
              <Badge
                variant="outline"
                className="font-normal"
                title={sourcesTooltip(event.sources, sourceLabels)}
              >
                {sourcesLabel(event.sources, sourceLabels)}
              </Badge>
            </>
          ) : (
            <>
              <Badge variant="outline" className="font-normal">
                {event.importKind === "company" ? "Company data" : "Friends"}
              </Badge>
              {/* A company import has no source axis, so it gets no chip — an empty one would read
                  as a missing value rather than as an axis that does not apply. */}
              {event.source && (
                <Badge variant="outline" className="font-normal">
                  {sourceLabels.get(event.source.toLowerCase()) ?? sourceLabel(event.source)}
                </Badge>
              )}
            </>
          )}
        </div>
      </div>

      <div className="shrink-0 space-y-0.5 text-right">
        <p className="text-xs tabular-nums text-muted-foreground">{formatRelativeTime(event.at)}</p>
        {event.kind === "run" ? (
          // The run's own page is the canonical place to read it — the trail links out rather than
          // restating what that page already renders.
          <Link
            href={`/comparisons/${event.id}`}
            className="text-xs font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline hover:underline"
          >
            {event.matches.toLocaleString()} {event.matches === 1 ? "match" : "matches"}
          </Link>
        ) : (
          <p className="text-xs tabular-nums text-muted-foreground">
            {event.records.toLocaleString()} {event.records === 1 ? "row" : "rows"}
          </p>
        )}
      </div>
    </div>
  );
}

/** The run's name, or the file's — falling back to what the row does have rather than to a blank. */
function title(event: AuditEvent): string {
  // A stock run name already carries its date, and the row prints the time beside it; stripping the
  // suffix is the same rule `runTitle` applies on Past runs.
  const stripped = event.name?.replace(/\s*·\s*\d{4}-\d{2}-\d{2}\s*$/, "").trim();
  if (stripped) return stripped;
  if (event.kind === "run") {
    return formatCompanies(event.companies, { conjunction: "and" }) ?? `Run ${event.id}`;
  }
  return event.importKind === "company" ? "Company import" : "Friends import";
}

/** Who did it, and what it did — one muted line under the name. */
function subtitle(event: AuditEvent): string {
  if (event.kind === "run") {
    const scope =
      event.companies.length > 0
        ? `against ${formatCompanies(event.companies, { conjunction: "and" })}`
        : "against every company on file";
    // Null is a real answer here, not a lookup that failed — a run predating `created_by` and not
    // opened by an import has nobody on file. See the file header.
    return event.actor ? `Started by ${event.actor} · ${scope}` : scope;
  }
  const rows = `${event.records.toLocaleString()} ${event.records === 1 ? "row" : "rows"}`;
  return event.actor ? `Imported by ${event.actor} · ${rows}` : rows;
}

/**
 * The status, in the vocabulary the rest of the app already uses.
 *
 * `rolled_back` is deliberately not `destructive`: an undone import is a normal, intended act, and
 * painting it the same red as a failure would report a tidy-up as a problem.
 */
function StatusBadge({ status }: { status: string }) {
  if (status === "completed") return <Badge variant="success">Completed</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (status === "rolled_back") return <Badge variant="secondary">Rolled back</Badge>;
  return <Badge variant="warning">Running</Badge>;
}
