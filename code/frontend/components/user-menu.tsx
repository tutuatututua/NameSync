"use client";

import * as React from "react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "./auth-provider";
import { cn } from "@/lib/utils";

/** First letters of the name, or the email's first character — never an empty circle. */
function initials(name: string | null, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const letters = parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0];
  return letters.toUpperCase();
}

/**
 * Who you are, and the way out. The signed-in identity has to be visible somewhere, or
 * "sign out" is a button with no subject — and on a shared machine that matters.
 */
export function UserMenu({ className }: { className?: string }) {
  const { user, signOut } = useAuth();
  const [signingOut, setSigningOut] = React.useState(false);

  if (!user) return null;

  const label = user.name?.trim() || user.email;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn("h-9 gap-2 px-1.5", className)}
          aria-label={`Account: ${label}`}
        >
          <span
            aria-hidden
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-semibold text-foreground"
          >
            {initials(user.name, user.email)}
          </span>
          {/* The name can be long and the sidebar is 240px; truncate rather than wrap. */}
          <span className="max-w-[7.5rem] truncate text-xs font-medium">{label}</span>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-sm font-medium">{label}</span>
          {/* Only repeat the email when the name isn't already it. */}
          {user.name?.trim() && (
            <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signingOut}
          onSelect={(event) => {
            // Keep the menu up while the request is in flight, so the item can show it is
            // working instead of the menu vanishing into an apparently frozen page.
            event.preventDefault();
            setSigningOut(true);
            void signOut().finally(() => setSigningOut(false));
          }}
        >
          <LogOut className="h-4 w-4" />
          {signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
