"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";
import { NavLink } from "./app-sidebar";
import { NAV_ITEMS, isActive } from "./nav-items";

/**
 * Mobile only.
 *
 * On desktop this was a 64px-tall bar holding one theme toggle and otherwise nothing — a
 * strip of chrome that pushed every page down by four rems to say nothing. The toggle moved
 * into the sidebar footer and the bar went with it; on desktop the page now starts at the
 * top of the window. What remains is the small-screen nav, which genuinely has nowhere else
 * to live.
 */
export function TopBar() {
  const pathname = usePathname() ?? "";
  const [open, setOpen] = React.useState(false);

  // Navigating inside the sheet has to close it — otherwise the panel stays open over the
  // page you just asked for.
  React.useEffect(() => setOpen(false), [pathname]);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-card/80 px-3 backdrop-blur-md md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Open navigation">
            <Menu />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-60 p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="flex h-14 items-center gap-2.5 border-b px-4">
            <span className="h-6 w-6 rounded-md bg-gradient-brand" aria-hidden />
            <span className="font-display text-md font-semibold tracking-tight">NameSync</span>
          </div>
          <nav className="space-y-0.5 px-2 py-2">
            {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
              <NavLink
                key={href}
                href={href}
                label={label}
                icon={Icon}
                active={isActive(pathname, href)}
                onNavigate={() => setOpen(false)}
              />
            ))}
          </nav>
        </SheetContent>
      </Sheet>

      <Link href="/" className="flex items-center gap-2">
        <span className="h-5 w-5 rounded bg-gradient-brand" aria-hidden />
        <span className="font-display font-semibold tracking-tight">NameSync</span>
      </Link>

      <div className="flex-1" />
      {/* On desktop the account lives in the sidebar footer — which is hidden on mobile,
          so without this there would be no way to sign out on a phone. */}
      <UserMenu />
      <ThemeToggle />
    </header>
  );
}
