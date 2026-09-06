import { MODEL_FAMILY_NAV_ITEMS } from "./model-families";
import { getProviderAccountPath, PROVIDER_ACCOUNT_DEFINITIONS, type ProviderAccountKey } from "./provider-accounts";

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

export type ProviderAccountCounts = Record<ProviderAccountKey, number>;

export type ProviderAccountIndicator = "normal" | "warning" | "error";

export type ProviderAccountIndicators = Record<ProviderAccountKey, ProviderAccountIndicator>;

export interface ModelFamilyCounts {
  [anchorId: string]: number;
}

const ACCOUNT_NAV_CHILDREN: NavSubItem[] = [...PROVIDER_ACCOUNT_DEFINITIONS]
  .filter((definition) => definition.showInNav !== false)
  .sort((a, b) => (a.navOrder ?? Number.MAX_SAFE_INTEGER) - (b.navOrder ?? Number.MAX_SAFE_INTEGER))
  .map((definition) => ({ name: definition.label, href: getProviderAccountPath(definition.key) }));

export const primaryNavigation: NavItem[] = [
  {
    name: "Accounts",
    href: "/dashboard",
    icon: "i-lucide-user",
    children: ACCOUNT_NAV_CHILDREN,
  },
  {
    name: "API Keys",
    href: "/dashboard/api-keys",
    icon: "i-lucide-key",
    children: [
      { name: "Sharing", href: "/dashboard/api-keys/sharing", control: "switch" },
    ],
  },
  {
    name: "Models",
    href: "/dashboard/models",
    icon: "i-lucide-cpu",
    children: MODEL_FAMILY_NAV_ITEMS.map((family) => ({
      name: family.name,
      href: "/dashboard/models",
      anchorId: family.anchorId,
    })),
  },
];
