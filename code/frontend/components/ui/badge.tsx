import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Badges are almost always sitting *inside* a table row, where a solid fill shouts over the
 * data it's meant to annotate. So every variant here is a tint plus a hairline — legible,
 * colour-coded, and quiet. `solid` exists for the rare badge that has to win.
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-2xs font-medium leading-none transition-colors [&_svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-primary/25 bg-primary/10 text-primary",
        secondary: "border-border bg-muted text-muted-foreground",
        destructive: "border-destructive/25 bg-destructive/10 text-destructive",
        success: "border-confidence-high/25 bg-confidence-high/10 text-confidence-high",
        warning: "border-confidence-medium/25 bg-confidence-medium/10 text-confidence-medium",
        outline: "border-border-strong bg-transparent text-muted-foreground",
        solid: "border-transparent bg-primary text-primary-foreground shadow-xs",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
