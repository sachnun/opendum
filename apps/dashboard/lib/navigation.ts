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
  tag?: string;
}

export interface ProviderAccountCounts {
  antigravity: number;
  codex: number;
  copilot: number;
  gemini_cli: number;
  groq: number;
  kilo_code: number;
  kiro: number;
  nvidia_nim: number;
  ollama_cloud: number;
  openrouter: number;
  qwen_code: number;
  workers_ai: number;
}

export type ProviderAccountIndicator = "normal" | "warning" | "error";

export type ProviderAccountIndicators = Record<keyof ProviderAccountCounts, ProviderAccountIndicator>;

export interface ModelFamilyCounts {
  [anchorId: string]: number;
}

export const primaryNavigation: NavItem[] = [
  { name: "Analytics", href: "/dashboard", icon: "i-lucide-trending-up" },
  {
    name: "Accounts",
    href: "/dashboard/accounts",
    icon: "i-lucide-user",
    children: [
      { name: "Antigravity", href: getProviderAccountPath("antigravity") },
      { name: "Codex", href: getProviderAccountPath("codex") },
      { name: "Copilot", href: getProviderAccountPath("copilot") },
      { name: "Gemini CLI", href: getProviderAccountPath("gemini_cli") },
      { name: "Kiro", href: getProviderAccountPath("kiro") },
      { name: "Nvidia", href: getProviderAccountPath("nvidia_nim") },
      { name: "Ollama Cloud", href: getProviderAccountPath("ollama_cloud") },
      { name: "OpenRouter", href: getProviderAccountPath("openrouter") },
      { name: "Groq", href: getProviderAccountPath("groq") },
      { name: "Kilo Code", href: getProviderAccountPath("kilo_code") },
      { name: "Workers AI", href: getProviderAccountPath("workers_ai") },
      { name: "Qwen Code", href: getProviderAccountPath("qwen_code") },
    ],
  },
  {
    name: "API Keys",
    href: "/dashboard/api-keys",
    icon: "i-lucide-key",
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
