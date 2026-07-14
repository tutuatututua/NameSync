import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md",
    "font-medium transition-all duration-fast ease-swift select-none",
    // A ring that sits *outside* the control against the page, so it reads on a card,
    // in a table row and on a coloured fill alike.
    "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-45",
    // A press should be felt. 1.5% is under the threshold of noticing it as animation and
    // over the threshold of feeling like a physical button.
    "active:scale-[0.985]",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90",
        // border-strong, not border: an outline button has to hold its own edge against a
        // card, and the hairline that's right for a table divider disappears here.
        outline:
          "border border-border-strong bg-card text-foreground shadow-xs hover:border-border-strong hover:bg-accent",
        secondary: "bg-secondary text-secondary-foreground hover:bg-accent",
        ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
        link: "h-auto p-0 text-primary underline-offset-4 hover:underline",
        // The signature, spent on exactly one thing per screen: the action you came to take.
        gradient:
          "bg-gradient-brand text-white shadow-sm hover:brightness-110 hover:shadow-md active:brightness-100",
      },
      size: {
        default: "h-9 px-3.5 text-sm",
        sm: "h-8 rounded-md px-2.5 text-xs",
        lg: "h-10 rounded-lg px-5 text-base",
        icon: "h-9 w-9",
        "icon-sm": "h-8 w-8 rounded-md",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
