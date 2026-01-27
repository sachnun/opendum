import {
  LayoutDashboard,
  User,
  Key,
  Cpu,
  LucideIcon,
} from "lucide-react";

export interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
}

export const navigation: NavItem[] = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "Accounts", href: "/dashboard/accounts", icon: User },
  { name: "API Keys", href: "/dashboard/api-keys", icon: Key },
  { name: "Models", href: "/dashboard/models", icon: Cpu },
];