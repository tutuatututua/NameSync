"use client";

import * as React from "react";
import { Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingButton } from "@/components/loading-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { UploadPanel } from "@/components/upload/UploadPanel";
import { useRunComparison, useSendWebhook } from "@/hooks/mutations";

/**
 * Import data into the database for one source. Uploads no longer run a comparison —
 * they merge into the cumulative table and forward the new rows to the ingestion
 * webhook. Comparison is a separate step (pick a company on the Compare page).
 */
export function ImportDialog({ source }: { source: "company" | "facebook" }) {
  const isCompany = source === "company";
  const [open, setOpen] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [uploader, setUploader] = React.useState("");

  const run = useRunComparison();
  const send = useSendWebhook();
  const busy = run.isPending || send.isPending;

  const reset = () => {
    setFile(null);
    setUploader("");
  };

  async function submit() {
    if (!file || !uploader.trim()) return;
    const form = new FormData();
    form.append(isCompany ? "companyFile" : "facebookFile", file);
    form.append("uploadPersonName", uploader.trim());
    form.set(
      "name",
      `${isCompany ? "Company" : "Facebook"} import · ${new Date().toLocaleDateString()}`
    );
    try {
      const data = await run.mutateAsync(form);
      await send.mutateAsync(data.sessionId); // forward new rows to the ingestion webhook
      const added = isCompany ? data.companyAdded : data.facebookAdded;
      const dupes = isCompany ? data.companyDuplicates : data.facebookDuplicates;
      toast.success(`Imported ${added.toLocaleString()} new row${added === 1 ? "" : "s"} (${dupes.toLocaleString()} duplicate${dupes === 1 ? "" : "s"} skipped)`);
      reset();
      setOpen(false);
    } catch {
      /* mutations surface errors as toasts */
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="gradient">
          <Upload className="h-4 w-4" /> Import
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import {isCompany ? "company" : "Facebook"} data</DialogTitle>
          <DialogDescription>
            Merges into the {isCompany ? "company" : "Facebook"} table (duplicates are skipped) and
            forwards the new rows to the processing service. This does not run a comparison.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <UploadPanel
            accept={isCompany ? [".csv"] : [".json"]}
            file={file}
            onChange={setFile}
            title={isCompany ? "Drop CSV" : "Drop JSON"}
            hint="or browse"
          />
          <div className="space-y-1.5">
            <Label htmlFor="import-uploader" className="text-xs">
              Upload user <span className="text-destructive">*</span>
            </Label>
            <Input
              id="import-uploader"
              value={uploader}
              onChange={(e) => setUploader(e.target.value)}
              placeholder="e.g. Alex"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <LoadingButton
            variant="gradient"
            isLoading={busy}
            disabled={!file || !uploader.trim()}
            onClick={submit}
          >
            <Upload className="h-4 w-4" /> Import
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
