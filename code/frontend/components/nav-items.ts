import { LayoutDashboard, GitCompareArrows, Building2, Users, History, UploadCloud, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/compare", label: "Compare", icon: GitCompareArrows },
  { href: "/data/company", label: "Company Data", icon: Building2 },
  { href: "/data/facebook", label: "Facebook Data", icon: Users },
  { href: "/uploads", label: "Uploads", icon: UploadCloud },
  { href: "/history", label: "History", icon: History },
];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
