import { LayoutDashboard, GitCompareArrows, Building2, Users, History, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/compare", label: "New Comparison", icon: GitCompareArrows },
  { href: "/data/company", label: "Company Data", icon: Building2 },
  { href: "/data/facebook", label: "Facebook Data", icon: Users },
  { href: "/history", label: "History", icon: History },
];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
