import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The inline notice box — "this file can't be imported", "worth checking", "saved to history".
 *
 * Three places built this by hand, and one of them reached for a raw `amber-500`, which is
 * the one colour in the app that doesn't move with the theme. Warnings now use the same
 * validated `--confidence-medium` token as everything else that means "caution", so there is
 * exactly one amber in the product.
 */
const TONES = {
  info: {
    icon: Info,
    box: "border-border bg-muted/50",
    title: "text-foreground",
  },
  success: {
    icon: CheckCircle2,
    box: "border-confidence-high/25 bg-confidence-high/10",
    title: "text-confidence-high",
  },
  warning: {
    icon: AlertTriangle,
    box: "border-confidence-medium/25 bg-confidence-medium/10",
    title: "text-confidence-medium",
  },
  danger: {
    icon: XCircle,
    box: "border-destructive/25 bg-destructive/10",
    title: "text-destructive",
  },
} as const;

export type CalloutTone = keyof typeof TONES;

export function Callout({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: CalloutTone;
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const { icon: Icon, box, title: titleClass } = TONES[tone];

  return (
    <div className={cn("flex gap-2.5 rounded-lg border p-3 text-sm", box, className)}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", titleClass)} aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className={cn("font-medium", titleClass)}>{title}</p>}
        {children && <div className="text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}
