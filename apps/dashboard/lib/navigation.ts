import {
  TrendingUp,
  User,
  Key,
  BookOpen,
  Cpu,
  FlaskConical,
  LucideIcon,
} from "lucide-react";
import { MODEL_FAMILY_NAV_ITEMS } from "@/lib/model-families";
import { getProviderAccountPath } from "@/lib/provider-accounts";

export interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
  children?: NavSubItem[];
}

export interface NavSubItem {
  name: string;
  href: string;
  anchorId?: string;
}

export interface ProviderAccountCounts {
  antigravity: number;
  copilot: number;
  codex: number;
  iflow: number;
  kiro: number;
  gemini_cli: number;
  qwen_code: number;
  nvidia_nim: number;
  ollama_cloud: number;
  openrouter: number;
}

export type ProviderAccountIndicator = "normal" | "warning" | "error";

export interface ProviderAccountIndicators {
  antigravity: ProviderAccountIndicator;
  copilot: ProviderAccountIndicator;
  codex: ProviderAccountIndicator;
  iflow: ProviderAccountIndicator;
  kiro: ProviderAccountIndicator;
  gemini_cli: ProviderAccountIndicator;
  qwen_code: ProviderAccountIndicator;
  nvidia_nim: ProviderAccountIndicator;
  ollama_cloud: ProviderAccountIndicator;
  openrouter: ProviderAccountIndicator;
}

export interface ModelFamilyCounts {
  [anchorId: string]: number;
}

export const primaryNavigation: NavItem[] = [
  { name: "Analytics", href: "/dashboard", icon: TrendingUp },
  {
    name: "Accounts",
    href: "/dashboard/accounts",
    icon: User,
    children: [
      {
        name: "Antigravity",
        href: getProviderAccountPath("antigravity"),
      },
      { name: "Codex", href: getProviderAccountPath("codex") },
      { name: "Copilot", href: getProviderAccountPath("copilot") },
      { name: "Kiro", href: getProviderAccountPath("kiro") },
      { name: "Iflow", href: getProviderAccountPath("iflow") },
      {
        name: "Gemini CLI",
        href: getProviderAccountPath("gemini_cli"),
      },
      { name: "Qwen Code", href: getProviderAccountPath("qwen_code") },
      {
        name: "Nvidia",
        href: getProviderAccountPath("nvidia_nim"),
      },
      {
        name: "Ollama Cloud",
        href: getProviderAccountPath("ollama_cloud"),
      },
      {
        name: "OpenRouter",
        href: getProviderAccountPath("openrouter"),
      },
    ],
  },
  { name: "API Keys", href: "/dashboard/api-keys", icon: Key },
  {
    name: "Models",
    href: "/dashboard/models",
    icon: Cpu,
    children: MODEL_FAMILY_NAV_ITEMS.map((family) => ({
      name: family.name,
      href: "/dashboard/models",
      anchorId: family.anchorId,
    })),
  },
];

export const supportNavigation: NavItem[] = [
  { name: "Usage", href: "/dashboard/usage", icon: BookOpen },
  { name: "Playground", href: "/dashboard/playground", icon: FlaskConical },
];

export const navigation: NavItem[] = [...primaryNavigation, ...supportNavigation];
