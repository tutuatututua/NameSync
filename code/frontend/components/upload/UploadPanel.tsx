"use client";

import * as React from "react";
import { UploadCloud, FileText, X } from "lucide-react";
import { validateFile } from "@/lib/files";
import { formatFileSize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface UploadPanelProps {
  accept: string[];
  file: File | null;
  onChange: (file: File | null) => void;
  title: string;
  hint?: string;
  maxSizeMB?: number;
}

export function UploadPanel({ accept, file, onChange, title, hint, maxSizeMB = 500 }: UploadPanelProps) {
  const [error, setError] = React.useState<string | null>(null);
  const [drag, setDrag] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

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
        <div className="flex items-center gap-3 rounded-xl border bg-card p-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileText className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{file.name}</p>
            <p className="text-sm text-muted-foreground">{formatFileSize(file.size)}</p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Remove file" onClick={() => pick(null)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            pick(e.dataTransfer.files?.[0] ?? null);
          }}
          className={cn(
            "flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            drag ? "border-primary bg-primary/5" : "border-input hover:border-primary/50"
          )}
        >
          <UploadCloud className="h-8 w-8 text-muted-foreground" />
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
