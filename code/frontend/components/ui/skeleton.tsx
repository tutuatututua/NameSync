import { cn } from "@/lib/utils";

/**
 * A sweep, not a blink. The old pulse faded a brand-tinted block in and out, which reads as
 * "something is wrong" more than "something is coming"; a directional shimmer reads as
 * loading. `shimmer` is defined in globals.css and respects prefers-reduced-motion.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("shimmer rounded-md bg-muted", className)} {...props} />;
}

export { Skeleton };
