"use client";

import * as React from "react";
import Link from "next/link";
import { Trash2, RefreshCw } from "lucide-react";
import type { CompanyDataRow } from "@extensions/contract";
import { DataManager, type Column } from "@/components/data-table/DataManager";
import { IdCell } from "@/components/data-table/IdCell";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/confirm-button";
import { useAllCompanyData } from "@/hooks/queries";
import { useDeleteCompanyRecord, useClearData } from "@/hooks/mutations";

const LIMIT = 20;
const columns: Column<CompanyDataRow>[] = [
  { key: "company_name", header: "Company", render: (r) => r.company_name ?? "—" },
  { key: "thai_name", header: "Thai name", render: (r) => r.person_name_th ?? "—" },
  { key: "eng_name", header: "English name", render: (r) => r.person_name_en ?? "—" },
  { key: "upload_person_name", header: "Uploaded by", render: (r) => r.upload_person_name ?? "—" },
  { key: "session_id", header: "Session", render: (r) => <IdCell value={r.session_id} /> },
  { key: "uuid", header: "UUID", render: (r) => <IdCell value={r.uuid} /> },
];

export default function CompanyDataPage() {
  const [page, setPage] = React.useState(1);
  const q = useAllCompanyData(page, LIMIT);
  const del = useDeleteCompanyRecord();
  const clear = useClearData("company");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Company Data</h1>
          <p className="text-muted-foreground">All company records across comparisons.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="gradient">
            <Link href="/compare?add=company">
              <RefreshCw className="h-4 w-4" /> Sync
            </Link>
          </Button>
          <ConfirmButton
            variant="outline"
            title="Clear all company data?"
            description="This permanently deletes every company record and its upload history."
            confirmLabel="Clear all"
            isLoading={clear.isPending}
            onConfirm={() => clear.mutateAsync()}
          >
            <Trash2 className="h-4 w-4" /> Clear all
          </ConfirmButton>
        </div>
      </div>
      <DataManager<CompanyDataRow>
        rows={q.data?.data ?? []}
        columns={columns}
        getRowId={(r) => r.uuid}
        total={q.data?.pagination.total ?? 0}
        page={page}
        limit={LIMIT}
        onPageChange={setPage}
        isLoading={q.isLoading}
        emptyText="No company data yet."
        onDeleteRow={(id) => del.mutateAsync(id)}
        isDeleting={del.isPending}
      />
    </div>
  );
}
