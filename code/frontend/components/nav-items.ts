import { GitCompareArrows, ScrollText, UploadCloud, Database, type LucideIcon } from "lucide-react";
import { mayOpenPage } from "@/lib/auth/access";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Four pages: the app does three things — compare, hold data, import data — and keeps a record of
 * having done them.
 *
 * Audit trail sits last because it is the only one that is not a step in any workflow. It is read
 * *about* the other three rather than used *with* them, so it belongs at the end of the rail rather
 * than between two pages people move between all day.
 *
 * What used to be here and why it isn't:
 *   Dashboard              — had no content of its own; it linked to Compare and previewed
 *                            the History list. Both now live on Compare, at "/".
 *   History                — same workflow as Compare, one step later. Merged into it.
 *   Company data / Friends — the same rows the Database console exposes as
 *                            `company_contact` and `friend`. Deep-link one with
 *                            /database?table=<name>.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Network", icon: GitCompareArrows },
  { href: "/uploads", label: "Uploads", icon: UploadCloud },
  { href: "/database", label: "Data", icon: Database },
  { href: "/audit", label: "Audit trail", icon: ScrollText },
];

/**
 * The nav for one account. A reviewer keeps "Network" and "Audit trail" — the other two are
 * pages AuthGuard would bounce them off, and a link that throws you back where you came
 * from is worse than no link.
 *
 * Filtered through the same `mayOpenPage` the guard uses, rather than a second hand-written
 * list, so the two can't disagree about what a reviewer may see.
 */
export function navItemsFor(roles: readonly string[]): NavItem[] {
  return NAV_ITEMS.filter((item) => mayOpenPage(roles, item.href));
}

/** Routes that belong to a nav item but don't sit under its href. A saved run's detail page
 *  is part of Compare — it's what you land on after saving one. */
const ALIASES: Record<string, string[]> = {
  "/": ["/comparisons"],
};

export function isActive(pathname: string, href: string): boolean {
  if (ALIASES[href]?.some((p) => pathname.startsWith(p))) return true;
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
