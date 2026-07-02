"use client";

import * as React from "react";
import { LoadingButton, type LoadingButtonProps } from "@/components/loading-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface ConfirmButtonProps extends Omit<LoadingButtonProps, "onClick"> {
  title: string;
  description?: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<unknown>;
}

export function ConfirmButton({
  title,
  description,
  confirmLabel = "Confirm",
  onConfirm,
  children,
  isLoading,
  ...rest
}: ConfirmButtonProps) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <LoadingButton {...rest} isLoading={isLoading} onClick={() => setOpen(true)}>
        {children}
      </LoadingButton>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction asChild>
              <LoadingButton
                variant="destructive"
                isLoading={isLoading}
                onClick={async (e) => {
                  e.preventDefault();
                  await onConfirm();
                  setOpen(false);
                }}
              >
                {confirmLabel}
              </LoadingButton>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
