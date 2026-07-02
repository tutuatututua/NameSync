import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const MAP: Record<string, { label: string; cls: string }> = {
  completed: { label: "Completed", cls: "border-confidence-high/30 bg-confidence-high/15 text-confidence-high" },
  processing: { label: "Processing", cls: "border-primary/30 bg-primary/15 text-primary" },
  pending_webhook: { label: "Ready to send", cls: "border-accent/30 bg-accent/15 text-accent" },
  pending: { label: "Pending", cls: "bg-muted text-muted-foreground" },
  failed: { label: "Failed", cls: "border-destructive/30 bg-destructive/15 text-destructive" },
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const s = MAP[status ?? ""] ?? { label: status ?? "Unknown", cls: "bg-muted text-muted-foreground" };
  return (
    <Badge variant="outline" className={cn(s.cls)}>
      {s.label}
    </Badge>
  );
}
