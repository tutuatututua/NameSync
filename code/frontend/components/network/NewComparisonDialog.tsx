"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { GitCompareArrows } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LoadingButton } from "@/components/loading-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CompanyPicker } from "@/components/company-picker";
import { useCompanies } from "@/hooks/queries";
import { useCompareByCompany } from "@/hooks/mutations";

/**
 * Run an ad-hoc comparison against a chosen set of companies.
 *
 * A secondary action, not a tab: with the external matcher an import already matches against
 * everything on file, so this is for the occasional "just these companies" run. On success it
 * hands off to the run's own page (`/comparisons/:id`) — the one canonical place a run is watched
 * and read — rather than an in-place state machine.
 */
export function NewComparisonDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const companies = useCompanies();
  const compareMut = useCompareByCompany();
  const [selected, setSelected] = React.useState<string[]>([]);

  // Fresh selection each time it opens.
  React.useEffect(() => {
    if (!open) setSelected([]);
  }, [open]);

  const hasCompanies = (companies.data?.length ?? 0) > 0;

  async function run() {
    if (selected.length === 0) return;
    try {
      const data = await compareMut.mutateAsync(selected);
      onOpenChange(false);
      router.push(`/comparisons/${data.sessionId}`);
    } catch {
      /* the mutation surfaces the error as a toast */
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Find connections</DialogTitle>
          <DialogDescription>
            Match every uploaded person against the companies you pick. Each person keeps their
            single closest match across the set — one run, not one per company.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="new-compare-companies">Companies</Label>
          <CompanyPicker
            id="new-compare-companies"
            companies={companies.data ?? []}
            selected={selected}
            onChange={setSelected}
            disabled={!hasCompanies}
            placeholder={hasCompanies ? "Select companies…" : "No companies yet"}
          />
          {!hasCompanies && !companies.isLoading && (
            <p className="text-sm text-muted-foreground">
              Import company data first to have something to compare against.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={compareMut.isPending}>
            Cancel
          </Button>
          <LoadingButton
            variant="gradient"
            isLoading={compareMut.isPending}
            disabled={selected.length === 0}
            onClick={run}
          >
            <GitCompareArrows className="h-4 w-4" /> Find connections
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
