"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Building2, Pencil, SearchX, UserCheck, Users } from "lucide-react";
import type { NameSearchRow } from "@extensions/contract";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatTile, compactCount } from "@/components/stat-tile";
import { RenameContactDialog, type EditableContact } from "@/components/network/RenameContactDialog";
import { useNetworkSearch } from "@/hooks/queries";

const PAGE_SIZE = 20;

/**
 * One company — everyone on file there, and who in your network can reach them.
 *
 * This is where a company row on the Overview (and a company name in Search) now leads, instead of
 * seeding the search box: a company is a place you go, with its own URL, back button and depth —
 * the two questions the client actually asks about a company ("who's there" and "who can get me
 * in") each get their own block here rather than being squeezed into a search result.
 *
 * It reads the same endpoint Search does, keyed by an EXACT company name (`company=`), so the
 * people, the company-wide connection count and the reaching uploaders are exactly what a search
 * for this company would show — one source of truth, two front doors.
 */
export default function CompanyPage() {
  const params = useParams<{ name: string }>();
  // Next decodes the route param, so this is the company's real (case-preserving) name.
  const company = decodeURIComponent(String(params.name));
  const [page, setPage] = React.useState(1);
  const { data, isLoading } = useNetworkSearch({ company, page, limit: PAGE_SIZE });
  const [editing, setEditing] = React.useState<EditableContact | null>(null);

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = data?.pagination.totalPages ?? 0;
  // Company-wide facts — same on every row (they're company-scoped subqueries), so read row one.
  const first = rows[0];
  const connections = first?.companyConnections ?? 0;
  const reachedBy = first?.companyUploaders ?? [];

  return (
    <div className="space-y-8">
      <PageHeader
        backHref="/"
        backLabel="Network"
        title={company}
        description="Everyone on file at this company, and who in your network can reach them."
        actions={
          !isLoading && total > 0 ? (
            <Badge variant={connections > 0 ? "success" : "outline"} className="h-7 gap-1 px-2.5">
              <Users className="h-3.5 w-3.5" />
              {connections} connection{connections === 1 ? "" : "s"}
            </Badge>
          ) : undefined
        }
      />

      {isLoading ? (
        <CompanySkeleton />
      ) : total === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No one on file for this company"
          description="The company may have been renamed or its contacts removed."
          action={
            <Button asChild variant="outline">
              <Link href="/">Back to Network</Link>
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile label="People on file" value={compactCount(total)} hint="contacts at this company" />
            <StatTile
              label="Connections"
              value={compactCount(connections)}
              hint="people in your network who reach here"
              emphasis
            />
            <StatTile
              label="Reachable by"
              value={compactCount(reachedBy.length)}
              hint={reachedBy.length === 1 ? "uploader" : "uploaders"}
            />
          </div>

          {/* Feature 2b — the uploaders with a connection to *someone* here, i.e. who can get you in. */}
          {reachedBy.length > 0 && (
            <div className="space-y-3">
              <SectionHeader
                title="Who can reach this company"
                description="Uploaders whose friend is connected to someone here."
              />
              <div className="flex flex-wrap gap-2">
                {reachedBy.map((u) => (
                  <Button key={u} asChild variant="outline" size="sm" className="h-8">
                    <Link href={`/uploaders/${encodeURIComponent(u)}`}>
                      <Users className="h-3.5 w-3.5" />
                      {u}
                    </Link>
                  </Button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-3">
            <SectionHeader title="People at this company" description={`${total.toLocaleString()} on file`} />
            <div className="overflow-hidden rounded-lg border">
              {rows.map((row) => (
                <PersonRow key={row.id} row={row} onEdit={() => setEditing(toEditable(row))} />
              ))}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between gap-3 pt-1">
                <p className="text-sm text-muted-foreground">
                  Page {page} of {totalPages}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      <RenameContactDialog
        contact={editing}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />
    </div>
  );
}

function toEditable(row: NameSearchRow): EditableContact {
  return {
    id: row.id,
    company_name: row.company_name,
    person_name_en: row.person_name_en,
    person_name_th: row.person_name_th,
  };
}

function PersonRow({ row, onEdit }: { row: NameSearchRow; onEdit: () => void }) {
  const name = row.person_name_en || row.person_name_th || "(no name)";
  const secondary = row.person_name_en && row.person_name_th ? row.person_name_th : null;

  return (
    <div className="flex items-start gap-3 border-b p-4 transition-colors last:border-b-0 hover:bg-muted/40">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
        <Building2 className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="truncate font-medium">{name}</p>
          {secondary && <span className="truncate text-sm text-muted-foreground">{secondary}</span>}
        </div>
        {/* Who in the network personally knows THIS contact — by name, each a link to their roster. */}
        {row.connectedUploaders.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            <span>Known by</span>
            {row.connectedUploaders.map((u) => (
              <Link key={u} href={`/uploaders/${encodeURIComponent(u)}`}>
                <Badge variant="success" title="Knows this person" className="cursor-pointer">
                  <UserCheck className="h-3 w-3" />
                  {u}
                </Badge>
              </Link>
            ))}
          </div>
        )}
      </div>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onEdit}
        aria-label={`Edit ${name}`}
        title="Edit name"
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <Pencil className="h-4 w-4" />
      </Button>
    </div>
  );
}

function CompanySkeleton() {
  return (
    <div className="space-y-8">
      <div className="grid gap-3 sm:grid-cols-3">
        <Skeleton className="h-[92px] rounded-lg" />
        <Skeleton className="h-[92px] rounded-lg" />
        <Skeleton className="h-[92px] rounded-lg" />
      </div>
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[64px] rounded-lg" />
        ))}
      </div>
    </div>
  );
}
