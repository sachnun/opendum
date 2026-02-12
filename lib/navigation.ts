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
  codex: number;
  iflow: number;
  kiro: number;
  gemini_cli: number;
  qwen_code: number;
  nvidia_nim: number;
  ollama_cloud: number;
  openrouter: number;
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
        href: "/dashboard/accounts",
        anchorId: "antigravity-accounts",
      },
      { name: "Codex", href: "/dashboard/accounts", anchorId: "codex-accounts" },
      { name: "Kiro", href: "/dashboard/accounts", anchorId: "kiro-accounts" },
      { name: "Iflow", href: "/dashboard/accounts", anchorId: "iflow-accounts" },
      {
        name: "Gemini CLI",
        href: "/dashboard/accounts",
        anchorId: "gemini-cli-accounts",
      },
      { name: "Qwen Code", href: "/dashboard/accounts", anchorId: "qwen-code-accounts" },
      {
        name: "Nvidia",
        href: "/dashboard/accounts",
        anchorId: "nvidia-nim-accounts",
      },
      {
        name: "Ollama Cloud",
        href: "/dashboard/accounts",
        anchorId: "ollama-cloud-accounts",
      },
      {
        name: "OpenRouter",
        href: "/dashboard/accounts",
        anchorId: "openrouter-accounts",
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
