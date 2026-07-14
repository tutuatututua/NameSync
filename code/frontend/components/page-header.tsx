import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * One header for every page.
 *
 * Each page used to build its own out of an `<h1>`, a `<p>`, and — on Compare — a stray
 * icon; the detail page bolted a back button inside the heading row and then indented the
 * subtitle by `ml-10` to clear it. Same job, four shapes. This is the shape.
 *
 * `actions` is the right-hand slot: the page's verbs live there, never in the title row.
 */
export function PageHeader({
  title,
  description,
  actions,
  backHref,
  backLabel = "Back",
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  backHref?: string;
  backLabel?: string;
  className?: string;
}) {
  return (
    <div className={cn("space-y-3", className)}>
      {backHref && (
        <Button asChild variant="ghost" size="sm" className="-ml-2.5 h-7 gap-1 px-2.5">
          <Link href={backHref}>
            <ArrowLeft className="h-3.5 w-3.5" />
            {backLabel}
          </Link>
        </Button>
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 space-y-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="max-w-2xl text-md leading-relaxed text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/**
 * A section heading inside a page — one step down from PageHeader, with the same
 * title/description/actions shape so the rhythm holds all the way down the page.
 */
export function SectionHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-2", className)}>
      <div className="min-w-0 space-y-0.5">
        <h2 className="font-display text-lg font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
