"use client";

import * as React from "react";
import Link from "next/link";
import { Trash2, Plus } from "lucide-react";
import type { FacebookDataRow } from "@extensions/contract";
import { DataManager, type Column } from "@/components/data-table/DataManager";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/confirm-button";
import { useAllFacebookData } from "@/hooks/queries";
import { useDeleteFacebookRecord, useClearData } from "@/hooks/mutations";
import { formatDate } from "@/lib/format";

const LIMIT = 20;
const columns: Column<FacebookDataRow>[] = [
  { key: "fb_name", header: "Facebook name", render: (r) => r.fb_name ?? "—" },
  { key: "upload_person_name", header: "Uploaded by", render: (r) => r.upload_person_name ?? "—" },
  { key: "timestamp", header: "Added", render: (r) => (r.timestamp ? formatDate(r.timestamp) : "—") },
];

export default function FacebookDataPage() {
  const [page, setPage] = React.useState(1);
  const q = useAllFacebookData(page, LIMIT);
  const del = useDeleteFacebookRecord();
  const clear = useClearData("facebook");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Facebook Data</h1>
          <p className="text-muted-foreground">All Facebook friends across comparisons.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="gradient">
            <Link href="/compare?add=facebook">
              <Plus className="h-4 w-4" /> Add &amp; Compare
            </Link>
          </Button>
          <ConfirmButton
            variant="outline"
            title="Clear all Facebook data?"
            description="This permanently deletes every Facebook record and its upload history."
            confirmLabel="Clear all"
            isLoading={clear.isPending}
            onConfirm={() => clear.mutateAsync()}
          >
            <Trash2 className="h-4 w-4" /> Clear all
          </ConfirmButton>
        </div>
      </div>
      <DataManager<FacebookDataRow>
        rows={q.data?.data ?? []}
        columns={columns}
        getRowId={(r) => r.uuid}
        total={q.data?.pagination.total ?? 0}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        isLoading={q.isLoading}
        emptyText="No Facebook data yet."
        onDeleteRow={(id) => del.mutateAsync(id)}
        isDeleting={del.isPending}
      />
    </div>
  );
}
