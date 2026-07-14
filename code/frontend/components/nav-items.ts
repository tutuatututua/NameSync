import { GitCompareArrows, UploadCloud, Database, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Three pages, because the app does three things: compare, hold data, import data.
 *
 * What used to be here and why it isn't:
 *   Dashboard              — had no content of its own; it linked to Compare and previewed
 *                            the History list. Both now live on Compare, at "/".
 *   History                — same workflow as Compare, one step later. Merged into it.
 *   Company / Facebook Data — the same rows the Database console exposes as
 *                            `company_contact` and `friend`. Deep-link one with
 *                            /database?table=<name>.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Compare", icon: GitCompareArrows },
  { href: "/uploads", label: "Uploads", icon: UploadCloud },
  { href: "/database", label: "Data", icon: Database },
];

/** Routes that belong to a nav item but don't sit under its href. A saved run's detail page
 *  is part of Compare — it's what you land on after saving one. */
const ALIASES: Record<string, string[]> = {
  "/": ["/comparisons"],
};

export function isActive(pathname: string, href: string): boolean {
  if (ALIASES[href]?.some((p) => pathname.startsWith(p))) return true;
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
