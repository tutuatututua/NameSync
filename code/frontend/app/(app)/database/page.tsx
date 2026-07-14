"use client";

import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { TableEditor } from "@/components/database/TableEditor";

/**
 * The Database console — the one place all the data lives. Browse, filter, import,
 * insert, edit and delete rows in the tables the server exposes
 * (api/src/lib/table-registry.ts).
 */
export default function DatabasePage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Database"
        description="Import data or edit rows directly."
      />

      {/* TableEditor keeps the selected table in the URL, so it reads useSearchParams. */}
      <React.Suspense fallback={<Skeleton className="h-64 w-full rounded-lg" />}>
        <TableEditor />
      </React.Suspense>
    </div>
  );
}
