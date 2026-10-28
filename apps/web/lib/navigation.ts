import { NAV_ITEMS } from "@opendum/models/ranking";
import { accountPath, PROVIDER_ACCOUNT_DEFINITIONS } from "@opendum/providers/provider-accounts";
import { Routes } from "~~/lib/routes";

export interface NavItem {
  name: string;
  href: string;
  icon: string;
  disabled?: boolean;
  children?: NavSubItem[];
}

export interface NavSubItem {
  name: string;
  href: string;
  anchorId?: string;
  disabled?: boolean;
  control?: "switch";
  tag?: string;
}

export type ProviderAccountCounts = Record<string, number>;

export type ProviderAccountIndicator = "normal" | "warning" | "error";

export type ProviderAccountIndicators = Record<string, ProviderAccountIndicator>;

export interface ModelFamilyCounts {
  [anchorId: string]: number;
}

const ACCOUNT_NAV_CHILDREN: NavSubItem[] = [...PROVIDER_ACCOUNT_DEFINITIONS]
  .sort((a, b) => (a.navOrder ?? Number.MAX_SAFE_INTEGER) - (b.navOrder ?? Number.MAX_SAFE_INTEGER))
  .map((definition) => ({ name: definition.label, href: accountPath(definition.key) }));

export const primaryNavigation: NavItem[] = [
  {
    name: "Accounts",
    href: Routes.home,
    icon: "i-lucide-user",
    children: ACCOUNT_NAV_CHILDREN,
  },
  {
    name: "API Keys",
    href: Routes.apiKeys,
    icon: "i-lucide-key",
    children: [
      { name: "Sharing", href: Routes.apiKeys, control: "switch" },
    ],
  },
  {
    name: "Models",
    href: Routes.models,
    icon: "i-lucide-cpu",
    children: NAV_ITEMS.map((family) => ({
      name: family.name,
      href: Routes.models,
      anchorId: family.anchorId,
    })),
  },
];

export function hrefOf(subItem: NavSubItem): string {
  if (subItem.anchorId) {
    return `${subItem.href}#${subItem.anchorId}`;
  }

  return subItem.href;
}

export function isSwitch(subItem: NavSubItem): boolean {
  return subItem.control === "switch";
}
