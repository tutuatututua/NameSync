"use client";

import * as React from "react";
import { UploadCloud, FileText, X } from "lucide-react";
import { validateFile } from "@/lib/files";
import { formatFileSize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface UploadPanelProps {
  accept: readonly string[];
  file: File | null;
  onChange: (file: File | null) => void;
  title: string;
  hint?: string;
  maxSizeMB?: number;
  /** Sizing for the drop target. The Uploads page wants a big one; the dialog doesn't. */
  className?: string;
}

export function UploadPanel({
  accept,
  file,
  onChange,
  title,
  hint,
  maxSizeMB = 500,
  className,
}: UploadPanelProps) {
  const [error, setError] = React.useState<string | null>(null);
  const [drag, setDrag] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  // A drag over a child element fires dragleave on the parent, so a bare boolean flickers
  // the whole target off and on as the cursor crosses the icon. Counting enter/leave pairs
  // is the standard fix.
  const dragDepth = React.useRef(0);

  const pick = (f: File | null) => {
    if (!f) {
      onChange(null);
      setError(null);
      return;
    }
    const err = validateFile(f, { accept, maxSizeMB });
    if (err) {
      setError(err);
      onChange(null);
      return;
    }
    setError(null);
    onChange(f);
  };

  return (
    <div>
      {file ? (
        <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
            <FileText className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{file.name}</p>
            <p className="text-xs tabular-nums text-muted-foreground">{formatFileSize(file.size)}</p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove file"
            onClick={() => pick(null)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragEnter={(e) => {
            e.preventDefault();
            dragDepth.current += 1;
            setDrag(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={(e) => {
            e.preventDefault();
            dragDepth.current -= 1;
            if (dragDepth.current <= 0) {
              dragDepth.current = 0;
              setDrag(false);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            dragDepth.current = 0;
            setDrag(false);
            pick(e.dataTransfer.files?.[0] ?? null);
          }}
          className={cn(
            "flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed p-8 text-center",
            "transition-colors duration-fast ease-swift",
            "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
            drag
              ? "border-primary bg-primary/5"
              : "border-border-strong bg-muted/30 hover:border-primary/50 hover:bg-muted/60",
            className
          )}
        >
          <UploadCloud
            className={cn(
              "mb-1 h-6 w-6 transition-colors",
              drag ? "text-primary" : "text-muted-foreground"
            )}
          />
          <span className="font-medium">{title}</span>
          {hint && <span className="text-sm text-muted-foreground">{hint}</span>}
          <span className="text-xs text-muted-foreground">Accepts {accept.join(", ")}</span>
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={accept.join(",")}
        className="hidden"
        onChange={(e) => pick(e.target.files?.[0] ?? null)}
        aria-label={title}
      />
      {error && (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
