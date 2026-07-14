import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The state you're in most often when the app is new, and the one the old UI treated as an
 * afterthought — a single grey sentence centred in a card, with no way out of it.
 *
 * An empty state has one job: say what's missing, and offer the action that fills it. The
 * `action` slot is the whole point; pass it whenever there is something the user can do.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border-strong bg-muted/30 px-6 py-14 text-center",
        className
      )}
    >
      {Icon && (
        <div className="flex h-10 w-10 items-center justify-center rounded-lg border bg-card text-muted-foreground shadow-xs">
          <Icon className="h-[18px] w-[18px]" />
        </div>
      )}
      <div className="space-y-1">
        <p className="font-medium text-foreground">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className="mt-1 flex items-center gap-2">{action}</div>}
    </div>
  );
}
