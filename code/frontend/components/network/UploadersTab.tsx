"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Search, UserCheck, UserX, Users } from "lucide-react";
import type { UploaderStats } from "@extensions/contract";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { SectionHeader } from "@/components/page-header";
import { useNetworkUploaders } from "@/hooks/queries";

/**
 * Uploaders (Feature 2a) — search an uploader, see how many of their friends matched and how many
 * didn't.
 *
 * The client's question is "for this person I uploaded, how many names did we place, how many are
 * still nowhere". The Overview answers it one roster at a time behind a dropdown; this puts every
 * roster in one list with its tally, filterable by name, and each row opens the roster's actual
 * names (matched, and — the useful half — not). The counts here are the same numbers the Overview
 * shows for a single roster, so the two never disagree.
 */
export function UploadersTab() {
  const { data, isLoading } = useNetworkUploaders();
  const [query, setQuery] = React.useState("");

  const uploaders = data?.uploaders ?? [];
  const q = query.trim().toLowerCase();
  const filtered = q ? uploaders.filter((u) => u.uploader.toLowerCase().includes(q)) : uploaders;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Uploaders"
        description="Search a person who uploaded friends to see how many matched — and how many didn't."
      />

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search an uploader by name…"
          className="pl-9"
          aria-label="Search an uploader by name"
        />
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[68px] rounded-lg" />
          ))}
        </div>
      ) : uploaders.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No uploaders yet"
          description="Import a friend list to see who's been uploaded and how far their network reaches."
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Search}
          title={`No uploader matches “${query.trim()}”`}
          description="Try a different spelling, or clear the search to see everyone."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          {filtered.map((u) => (
            <UploaderRow key={u.uploader} stats={u} />
          ))}
        </div>
      )}
    </div>
  );
}

function UploaderRow({ stats }: { stats: UploaderStats }) {
  return (
    <Link
      href={`/uploaders/${encodeURIComponent(stats.uploader)}`}
      className="group flex items-center gap-3 border-b p-4 outline-none transition-colors last:border-b-0 hover:bg-muted/40 focus-visible:bg-muted/40"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border bg-muted text-sm font-medium text-muted-foreground">
        {initial(stats.uploader)}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{stats.uploader}</p>
        <p className="text-sm text-muted-foreground">
          {stats.friends.toLocaleString()} friend{stats.friends === 1 ? "" : "s"} uploaded
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant={stats.matched > 0 ? "success" : "outline"} title="Friends with a connection">
          <UserCheck className="h-3 w-3" />
          {stats.matched} matched
        </Badge>
        <Badge variant="outline" title="Friends with no connection yet" className="text-muted-foreground">
          <UserX className="h-3 w-3" />
          {stats.noMatch} no match
        </Badge>
      </div>
      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </Link>
  );
}

/** The avatar stand-in — first character of the name, upper-cased. */
function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}
