"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Building2, Pencil, Search } from "lucide-react";
import type { NameSearchRow } from "@extensions/contract";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { SectionHeader } from "@/components/page-header";
import { PAGE_SIZE, Pager } from "@/components/pagination";
import { KnownByBadge } from "@/components/network/KnownByBadge";
import { RenameContactDialog, type EditableContact } from "@/components/network/RenameContactDialog";
import { useNetworkSearch } from "@/hooks/queries";
import { withThreshold } from "@/hooks/useThreshold";
import { cn } from "@/lib/utils";

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
 * Search (Feature 2) — find a person, see which company they're in, and see WHO KNOWS THEM. The
 * pencil edits the contact's name (Feature 3).
 *
 * ONE QUESTION PER ROW. A result used to carry two: who knows this contact, and who reaches their
 * company through anyone at all. The second was the same answer on every row of a company (it is a
 * company-scoped subquery) rendered per contact, in the same chips as the first — see the note in
 * `ResultRow` for why it moved to the company page, which is where the reader is already asking it.
 *
 * A company name deep-links here from the Overview (`?tab=search&q=<company>`), which is why the
 * box seeds from the URL — searching a company name lists its people.
 *
 * The workspace bar (`threshold`) grades the connections and NOT the result set: who is on file at
 * a company is a fact about `company_contact`, so tightening the bar empties the chips beside a
 * contact rather than removing the contact. "Nobody you know is here" and "nobody is here" are
 * different answers and this page has to keep being able to say the first one.
 */
export function SearchTab({ threshold = null }: { threshold?: number | null }) {
  const urlQ = useSearchParams().get("q") ?? "";
  const [input, setInput] = React.useState(urlQ);
  // Follow the URL when Overview deep-links a company into the box.
  React.useEffect(() => {
    if (urlQ) setInput(urlQ);
  }, [urlQ]);

  const q = useDebouncedValue(input.trim(), 300);
  const [page, setPage] = React.useState(1);
  React.useEffect(() => setPage(1), [q]);

  const { data, isLoading, isFetching } = useNetworkSearch({
    q,
    page,
    limit: PAGE_SIZE,
    threshold: threshold ?? undefined,
  });
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
          {/* Dimmed while a new bar (or page) is in flight — the chips are what move, and swapping
              them under the reader with no signal reads as the data having changed. */}
          <div
            className={cn(
              "overflow-hidden rounded-lg border transition-opacity",
              isFetching && "opacity-60"
            )}
          >
            {rows.map((row) => (
              <ResultRow
                key={row.id}
                row={row}
                threshold={threshold}
                onEdit={() => setEditing(toEditable(row))}
              />
            ))}
          </div>

          {/* The result count is already stated above the list, so the summary here is the plain
              one — two "812 results" a screen apart would read as two different numbers. */}
          <Pager
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            label="search results"
            // `pending`, not `disabled`: the old control greyed itself out on every page turn, which
            // is the one moment a reader may want to press again. The rows already dim; this says
            // what the dim means.
            pending={isFetching}
            className="pt-1"
          />
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

function ResultRow({
  row,
  threshold,
  onEdit,
}: {
  row: NameSearchRow;
  /** Carried onto every link out of this row, so a roster or company opened from here is read at
   *  the same bar the chips beside it were graded at. */
  threshold: number | null;
  onEdit: () => void;
}) {
  const name = row.person_name_en || row.person_name_th || "(no name)";
  const secondary = row.person_name_en && row.person_name_th ? row.person_name_th : null;

  return (
    <div className="flex items-start gap-3 border-b p-4 transition-colors last:border-b-0 hover:bg-muted/40">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="truncate font-medium">{name}</p>
          {/* Who in the network actually knows THIS person: the owner to ask, WHICH of their
              friends the matcher paired with the name above, what it compared, and how close it
              came. Each chip links to that owner's roster. */}
          {row.connectedUploaders.map((u) => (
            <Link key={u.name} href={withThreshold(`/uploaders/${encodeURIComponent(u.name)}`, threshold)}>
              <KnownByBadge uploader={u} />
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Building2 className="h-3.5 w-3.5 shrink-0" />
          {row.company_name ? (
            // The company is a place you can go — same destination as an Overview company row.
            <Link
              href={withThreshold(`/companies/${encodeURIComponent(row.company_name)}`, threshold)}
              className="truncate font-medium text-foreground underline-offset-2 hover:underline"
            >
              {row.company_name}
            </Link>
          ) : (
            <span className="truncate">No company</span>
          )}
          {secondary && <span className="truncate">· {secondary}</span>}
        </div>
        {/*
          NO "Reached by" LINE — who reaches the COMPANY lives on the company page (2026-08-07).

          `row.companyUploaders` is a company-scoped subquery, so it is the SAME list on every row
          of a company: three BANGKOK BANK contacts on one screen printed the same five names three
          times, and eight CENTRAL RETAIL contacts printed another five eight times. Repetition is
          the smaller half of the problem. It sat directly beneath the chips above, which are the
          one thing on the row that IS per-contact, in the same chip vocabulary — so the row's most
          eye-catching element was its least informative one, and a reader scanning for "who knows
          this person" had to learn by inspection which of two chip rows answered that.

          It is not lost: the company name on the line above links to the company page, which reads
          the identical array off the identical endpoint and states it ONCE, in the header, where a
          fact about the company belongs. Search answers "who knows this person"; the page it links
          to answers "who can get me in". One question per surface.
        */}
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
