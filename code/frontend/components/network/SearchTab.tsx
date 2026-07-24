"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Building2, Pencil, Search, Users } from "lucide-react";
import type { NameSearchRow } from "@extensions/contract";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { SectionHeader } from "@/components/page-header";
import { KnownByBadge } from "@/components/network/KnownByBadge";
import { RenameContactDialog, type EditableContact } from "@/components/network/RenameContactDialog";
import { useNetworkSearch } from "@/hooks/queries";

const PAGE_SIZE = 20;

/** Hold a value still for `delay`ms after the last change — one request per pause, not per keystroke. */
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/**
 * Search (Feature 2) — find a person, see which company they're in and whether the network
 * reaches it. Each result carries two facts from stored results: how many people reach that whole
 * company, and whether this exact contact is themselves someone's connection. The pencil edits the
 * contact's name (Feature 3).
 *
 * A company name deep-links here from the Overview (`?tab=search&q=<company>`), which is why the
 * box seeds from the URL — searching a company name lists its people.
 */
export function SearchTab() {
  const urlQ = useSearchParams().get("q") ?? "";
  const [input, setInput] = React.useState(urlQ);
  // Follow the URL when Overview deep-links a company into the box.
  React.useEffect(() => {
    if (urlQ) setInput(urlQ);
  }, [urlQ]);

  const q = useDebouncedValue(input.trim(), 300);
  const [page, setPage] = React.useState(1);
  React.useEffect(() => setPage(1), [q]);

  const { data, isLoading, isFetching } = useNetworkSearch({ q, page, limit: PAGE_SIZE });
  const [editing, setEditing] = React.useState<EditableContact | null>(null);

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = data?.pagination.totalPages ?? 0;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Find a person"
        description="Search a name to see which company they're in and whether your network reaches it."
      />

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search a person or company…"
          className="pl-9"
          aria-label="Search a person or company"
          autoFocus
        />
      </div>

      {q.length === 0 ? (
        <EmptyState
          icon={Search}
          title="Search company people"
          description="Type a name (or a company) to look them up and see who in your network connects to them."
        />
      ) : isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[64px] rounded-lg" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Search}
          title={`No one matches “${q}”`}
          description="Try a different spelling, or a shorter search."
        />
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {total.toLocaleString()} {total === 1 ? "result" : "results"}
          </p>
          <div className="overflow-hidden rounded-lg border">
            {rows.map((row) => (
              <ResultRow key={row.id} row={row} onEdit={() => setEditing(toEditable(row))} />
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
                  disabled={page <= 1 || isFetching}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages || isFetching}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
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

function ResultRow({ row, onEdit }: { row: NameSearchRow; onEdit: () => void }) {
  const name = row.person_name_en || row.person_name_th || "(no name)";
  const secondary = row.person_name_en && row.person_name_th ? row.person_name_th : null;

  return (
    <div className="flex items-start gap-3 border-b p-4 transition-colors last:border-b-0 hover:bg-muted/40">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="truncate font-medium">{name}</p>
          {/* Who in the network actually knows THIS person — by name, each a link to their roster,
              each with how close the match that connects them was. */}
          {row.connectedUploaders.map((u) => (
            <Link key={u.name} href={`/uploaders/${encodeURIComponent(u.name)}`}>
              <KnownByBadge uploader={u} />
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Building2 className="h-3.5 w-3.5 shrink-0" />
          {row.company_name ? (
            // The company is a place you can go — same destination as an Overview company row.
            <Link
              href={`/companies/${encodeURIComponent(row.company_name)}`}
              className="truncate font-medium text-foreground underline-offset-2 hover:underline"
            >
              {row.company_name}
            </Link>
          ) : (
            <span className="truncate">No company</span>
          )}
          {secondary && <span className="truncate">· {secondary}</span>}
        </div>
        {/* Who reaches this COMPANY at all (via anyone there) — "who can get me in". */}
        {row.companyUploaders.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            <Users className="h-3.5 w-3.5 shrink-0" />
            <span>Reached by</span>
            {row.companyUploaders.map((u) => (
              <Link key={u} href={`/uploaders/${encodeURIComponent(u)}`}>
                <Badge variant="outline" title="Connects to someone at this company" className="cursor-pointer">
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
