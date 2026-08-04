"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Building2, Import, Pencil, SearchX, UserCheck, UserSearch, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NameSearchRow } from "@extensions/contract";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatTile, compactCount } from "@/components/stat-tile";
import { sameName } from "@/components/network/KnownByBadge";
import { ConnectionCard } from "@/components/network/ConnectionCard";
import {
  MatchedHint,
  ReachLeads,
  companyReachTitle,
  reachBadgeVariant,
} from "@/components/network/match-grade";
import { RenameContactDialog, type EditableContact } from "@/components/network/RenameContactDialog";
import { useNetworkSearch } from "@/hooks/queries";
import { readThreshold, withThreshold } from "@/hooks/useThreshold";

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
 *
 * ── The connections are rows, not chips (and Search's are still chips) ──
 *
 * Two front doors onto one payload does not mean two identical renderings of it. Search is a
 * lookup: many contacts, one line each, and a chip that names the owner is the whole of what fits
 * and most of what is wanted. This page is the destination — one company, one contact under the
 * cursor, and the next action is an email to a colleague — so it owes the reader the evidence
 * behind the badge rather than the badge alone: which friend, matched against which spelling of
 * this contact, under which comparison, on whose roster, imported by whom. `ConnectionCard` is
 * that row, and the grading vocabulary inside it is the contract's, shared with the chips, so the
 * two surfaces cannot disagree about what "confirmed" means.
 */
export default function CompanyPage() {
  const params = useParams<{ name: string }>();
  // Next decodes the route param, so this is the company's real (case-preserving) name.
  const company = decodeURIComponent(String(params.name));
  /**
   * The bar the Network page was tuned to, carried here on the link that opened this page.
   *
   * READ, never set: there is no control on this page, and adding one would put two authorities on
   * screen for the same setting. The tiles below are the same numbers the row you clicked was
   * showing, so they have to be graded the same way — a company listed as "3 connections" opening
   * on a page counting twelve is the contradiction this parameter exists to prevent.
   */
  const threshold = readThreshold(useSearchParams().get("threshold"));
  const [page, setPage] = React.useState(1);
  const { data, isLoading } = useNetworkSearch({
    company,
    page,
    limit: PAGE_SIZE,
    threshold: threshold ?? undefined,
  });
  const [editing, setEditing] = React.useState<EditableContact | null>(null);

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = data?.pagination.totalPages ?? 0;
  // Company-wide facts — same on every row (they're company-scoped subqueries), so read row one.
  const first = rows[0];
  const connections = first?.companyConnections ?? 0;
  const connectionsConfirmed = first?.companyConnectionsConfirmed ?? 0;
  const reachedBy = first?.companyUploaders ?? [];
  // How many of the owners below can reach this company on a whole name — the "Reachable by" tile's
  // split, read off the same array the chips are drawn from.
  const reachedByConfirmed = reachedBy.filter((u) => u.confirmed).length;

  return (
    <div className="space-y-8">
      <PageHeader
        // Back to the workspace AT THE BAR you left it on — a back link that reset the tuning
        // would make every drill-down a one-way trip.
        backHref={withThreshold("/", threshold)}
        backLabel="Network"
        title={company}
        description="Everyone on file at this company, and who in your network can reach them."
        actions={
          !isLoading && total > 0 ? (
            <Badge
              variant={connections === 0 ? "outline" : reachBadgeVariant(connectionsConfirmed)}
              className="h-7 gap-1 px-2.5"
              title={connections > 0 ? companyReachTitle(connections, connectionsConfirmed) : undefined}
            >
              <Users className="h-3.5 w-3.5" />
              {connections} connection{connections === 1 ? "" : "s"}
              <ReachLeads connections={connections} confirmed={connectionsConfirmed} />
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
              {/* At the bar you left, like the back link in the header — the two go to the same
                  place and must not disagree about which workspace you return to. */}
              <Link href={withThreshold("/", threshold)}>Back to Network</Link>
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
              hint={
                <MatchedHint
                  matched={connections}
                  confirmed={connectionsConfirmed}
                  fallback="people in your network who reach here"
                />
              }
              emphasis
            />
            <StatTile
              label="Reachable by"
              value={compactCount(reachedBy.length)}
              hint={
                <MatchedHint
                  matched={reachedBy.length}
                  confirmed={reachedByConfirmed}
                  fallback={reachedBy.length === 1 ? "relationship owner" : "relationship owners"}
                />
              }
            />
          </div>

          {/* Feature 2b — the relationship owners with a connection to *someone* here, i.e. who can
              get you in. */}
          {reachedBy.length > 0 && (
            <div className="space-y-3">
              <SectionHeader
                title="Who can reach this company"
                description="Relationship owners whose friend is connected to someone here."
              />
              {/* Graded like KnownByBadge, minus the score: company reach is not one pairing, so
                  there is no single number to put on it — but strength folds, because it is ordinal
                  with a defined winner. An owner whose only route in is a shared surname must not
                  look identical to one whose friend IS somebody here.

                  The importer moved out of the tooltip and onto the tile's second line. It is the
                  same argument the connection rows make: owner and importer are two people, and a
                  provenance that only exists on hover is provenance most readers never see. There
                  is room for it here because these are tiles rather than chips — the roster page
                  behind each one is where a roster assembled by several people is listed in full. */}
              <div className="flex flex-wrap gap-2">
                {reachedBy.map((u) => {
                  const Icon = u.confirmed ? UserCheck : UserSearch;
                  const selfImported = sameName(u.uploadedBy, u.name);
                  return (
                    <Button
                      key={u.name}
                      asChild
                      variant="outline"
                      size="sm"
                      className={cn(
                        "h-auto items-start py-2",
                        !u.confirmed && "border-confidence-medium/40 text-confidence-medium"
                      )}
                      title={
                        u.confirmed
                          ? `${u.name} has a whole-name match with someone here.`
                          : `${u.name} only reaches this company on a partial-name match — check before asking for an introduction.`
                      }
                    >
                      <Link href={withThreshold(`/uploaders/${encodeURIComponent(u.name)}`, threshold)}>
                        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="flex flex-col items-start gap-0.5 text-left">
                          <span className="font-medium">{u.name}</span>
                          <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
                            <Import className="h-3 w-3 shrink-0" aria-hidden />
                            {u.uploadedBy
                              ? selfImported
                                ? "imported their own roster"
                                : `imported by ${u.uploadedBy}`
                              : "importer not recorded"}
                          </span>
                        </span>
                      </Link>
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-3">
            <SectionHeader
              title="People at this company"
              description={`${total.toLocaleString()} on file — each connection shows which friend was matched against which name, whose relationship it is, and who uploaded it.`}
            />
            <div className="overflow-hidden rounded-lg border">
              {rows.map((row) => (
                <PersonRow
                  key={row.id}
                  row={row}
                  threshold={threshold}
                  onEdit={() => setEditing(toEditable(row))}
                />
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

/**
 * One contact on file here, and every connection into them written out in full.
 *
 * The connections used to be a strip of chips (`Known by [tua · 100%]`), which named the owner and
 * the score and stopped there — so the row asserted a match without ever showing the two names that
 * were matched. On a partial-name run that is not a shortened claim but a different one: `tua ·
 * surname 94%` beside `sunisa phongphaew` reads as "tua knows sunisa", when what the run found may
 * be that tua has a friend called `nattapong phongphaew`. Each connection now gets a row of its own
 * (`ConnectionCard`) carrying the pairing, the comparison, the owner and the importer.
 *
 * Contacts with no connection stay exactly one line tall — the great majority of a company's people
 * are nobody's friend, and paying height for them would bury the few rows that matter. They say so
 * in a single grey sentence rather than rendering nothing, because "no one reaches this person" is
 * an answer to the question the page is about, and a blank space is not.
 */
function PersonRow({
  row,
  threshold,
  onEdit,
}: {
  row: NameSearchRow;
  /** Passed down to each connection's owner link — the last link on this page that was still
   *  dropping the bar, and the one a reader is most likely to click: the owner IS the next action. */
  threshold: number | null;
  onEdit: () => void;
}) {
  const name = row.person_name_en || row.person_name_th || "(no name)";
  const secondary = row.person_name_en && row.person_name_th ? row.person_name_th : null;
  const connections = row.connectedUploaders;

  return (
    <div className="border-b p-4 transition-colors last:border-b-0 hover:bg-muted/40">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
          <Building2 className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="truncate font-medium">{name}</p>
            {secondary && (
              <span lang="th" className="truncate text-sm text-muted-foreground">
                {secondary}
              </span>
            )}
          </div>
          {connections.length === 0 && (
            <p className="text-sm text-muted-foreground">No one in your network is connected to this person.</p>
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

      {/* Indented to the contact's name, not to the row edge: these are facts ABOUT the person
          above them, and starting them at the same margin would read as a second list. */}
      {connections.length > 0 && (
        <div className="mt-3 space-y-2 sm:pl-11">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Known by {connections.length === 1 ? "1 friend" : `${connections.length} friends`}
          </p>
          {connections.map((u) => (
            <ConnectionCard key={u.name} uploader={u} contact={row} threshold={threshold} />
          ))}
        </div>
      )}
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
