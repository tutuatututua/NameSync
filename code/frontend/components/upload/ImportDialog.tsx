"use client";

import * as React from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { UploadPanel } from "@/components/upload/UploadPanel";
import { ImportReview, type ImportSource } from "@/components/upload/ImportReview";

/**
 * Import, in a dialog — the Database console's entry point, sitting on the table an import
 * feeds. The Uploads page runs the same two steps inline, at full width, because that's the
 * page whose job this is. Both share ImportReview, so the preview can't differ between them.
 *
 * Pick a file, see what it holds, then commit. Nothing is written until you do.
 */
export function ImportDialog({
  source,
  label = "Import",
}: {
  source: ImportSource;
  label?: string;
}) {
  const isCompany = source === "company";
  const [open, setOpen] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);

  const close = () => {
    setOpen(false);
    setFile(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setFile(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="gradient">
          <Upload className="h-4 w-4" /> {label}
        </Button>
      </DialogTrigger>

      {/* Wide enough for the column map and the sample rows to be readable. */}
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import {isCompany ? "company" : "Facebook"} data</DialogTitle>
          <DialogDescription>
            {file
              ? "Check the columns and rows below, then import. Nothing has been written yet."
              : `Merges into the ${
                  isCompany ? "company" : "Facebook"
                } table (duplicates are skipped) and forwards the new rows to the processing service. This does not run a comparison.`}
          </DialogDescription>
        </DialogHeader>

        {file ? (
          <ImportReview source={source} file={file} onCancel={() => setFile(null)} onComplete={close} />
        ) : (
          <UploadPanel
            accept={[".xlsx"]}
            file={null}
            onChange={setFile}
            title="Drop XLSX"
            hint="or browse"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
