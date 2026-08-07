import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The bar over one bordered list on the roster page — a company's matches, or one half of the
 * unplaced.
 *
 * Both sections had grown their own copy of this and they had already drifted by a padding step,
 * which is visible: the two lists sit one above the other on the same page. The only real
 * difference is that a company header goes somewhere and a heading over "Not yet scored" does not,
 * so `href` is optional and the interactive affordances (hover, focus ring, cursor) come with it
 * rather than being painted on a div that does nothing.
 */
export function GroupHeader({
  icon: Icon,
  title,
  detail,
  href,
  titleLang,
  tooltip,
}: {
  icon: LucideIcon;
  title: string;
  /** The right-hand clause — a count, a split, an ordering. A node so a group can tint its leads
   *  amber without every caller assembling the paragraph by hand. */
  detail?: React.ReactNode;
  /** Where the title leads, when it leads anywhere. */
  href?: string;
  /** `th` when the title is Thai — see `thaiLang`. */
  titleLang?: "th";
  /** The sentence behind `detail`, spelled out. Counts on one line are a shorthand; this is what
   *  they are shorthand for. */
  tooltip?: string;
}) {
  const inner = (
    <>
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span lang={titleLang} className="min-w-0 flex-1 truncate font-medium">
        {title}
      </span>
      {detail && (
        <span className="shrink-0 text-sm text-muted-foreground" title={tooltip}>
          {detail}
        </span>
      )}
    </>
  );

  const className = cn(
    "flex items-center gap-2 border-b bg-muted/40 px-4 py-2.5",
    href && "outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60"
  );

  return href ? (
    <Link href={href} className={className}>
      {inner}
    </Link>
  ) : (
    <div className={className}>{inner}</div>
  );
}
