"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";

export interface LoadingButtonProps extends ButtonProps {
  isLoading?: boolean;
}

/**
 * Button that owns its loading state. `disabled` is pulled out of props and
 * recomputed as `disabled || isLoading` LAST, so a caller passing disabled={false}
 * can never re-enable a button mid-submit (fixes M1); bind isLoading to a
 * mutation's isPending to prevent double-submit (fixes M2).
 */
export const LoadingButton = React.forwardRef<HTMLButtonElement, LoadingButtonProps>(
  ({ isLoading = false, disabled, children, ...props }, ref) => (
    <Button ref={ref} disabled={disabled || isLoading} {...props}>
      {isLoading && <Loader2 className="animate-spin" aria-hidden />}
      {children}
    </Button>
  )
);
LoadingButton.displayName = "LoadingButton";
