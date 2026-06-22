import { MODEL_FAMILY_NAV_ITEMS } from "./model-families";
import { getProviderAccountPath } from "./provider-accounts";

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

export interface ProviderAccountCounts {
  antigravity: number;
  codex: number;
  command_code: number;
  kiro: number;
  nvidia_nim: number;
  openrouter: number;
  siliconflow: number;
  workers_ai: number;
  zenmux: number;
}

export type ProviderAccountIndicator = "normal" | "warning" | "error";

export type ProviderAccountIndicators = Record<keyof ProviderAccountCounts, ProviderAccountIndicator>;

export interface ModelFamilyCounts {
  [anchorId: string]: number;
}

export const primaryNavigation: NavItem[] = [
  {
    name: "Accounts",
    href: "/dashboard",
    icon: "i-lucide-user",
    children: [
      { name: "Antigravity", href: getProviderAccountPath("antigravity") },
      { name: "Codex", href: getProviderAccountPath("codex") },
      { name: "Command Code", href: getProviderAccountPath("command_code") },
      { name: "Kiro", href: getProviderAccountPath("kiro") },
      { name: "Nvidia", href: getProviderAccountPath("nvidia_nim") },
      { name: "OpenRouter", href: getProviderAccountPath("openrouter") },
      { name: "ZenMux", href: getProviderAccountPath("zenmux") },
      { name: "SiliconFlow", href: getProviderAccountPath("siliconflow") },
      { name: "Cloudflare", href: getProviderAccountPath("workers_ai") },
    ],
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
