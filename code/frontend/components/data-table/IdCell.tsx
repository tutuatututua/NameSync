import * as React from "react";

/** Compact, copyable cell for long identifiers (uuid, session_id): truncated with
 *  the full value available on hover so the table stays readable. */
export function IdCell({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="block max-w-[9rem] truncate font-mono text-xs text-muted-foreground" title={value}>
      {value}
    </span>
  );
}
