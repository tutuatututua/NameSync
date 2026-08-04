"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItemsFor, isActive } from "./nav-items";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";
import { usePermissions } from "./auth-provider";
import { cn } from "@/lib/utils";

export function AppSidebar() {
  const pathname = usePathname() ?? "";
  const { roles } = usePermissions();
  const navItems = navItemsFor(roles);
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-card md:flex">
      <Link
        href="/"
        className="flex h-14 items-center gap-2.5 px-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span className="h-6 w-6 rounded-md bg-gradient-brand shadow-xs" aria-hidden />
        <span className="font-display text-md font-semibold tracking-tight">Network Intel</span>
      </Link>

      <nav className="flex-1 space-y-0.5 px-2 py-2">
        {navItems.map(({ href, label, icon: Icon }) => (
          <NavLink key={href} href={href} label={label} icon={Icon} active={isActive(pathname, href)} />
        ))}
      </nav>

      {/* The theme toggle used to float alone in the top bar, which left the top bar with
          nothing else in it. It belongs down here with the app's other chrome — and now
          alongside the account, which is the other thing that is about you rather than the
          page you happen to be on. The tagline that used to sit here gave way to it: who is
          signed in earns the space more than a slogan does. */}
      <div className="flex items-center justify-between gap-1 border-t px-2.5 py-2.5">
        <UserMenu />
        <ThemeToggle />
      </div>
    </aside>
  );
}

/**
 * Active nav is a filled surface plus a brand rule on the leading edge — not brand-coloured
 * text on a brand-tinted pill, which is the same shout twice. The rule is the only brand ink
 * in the sidebar besides the logo.
 */
export function NavLink({
  href,
  label,
  icon: Icon,
  active,
  onNavigate,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium",
        "transition-colors duration-fast ease-swift",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary transition-opacity duration-fast",
          active ? "opacity-100" : "opacity-0"
        )}
      />
      <Icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
      {label}
    </Link>
  );
}
