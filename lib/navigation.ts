import {
  TrendingUp,
  User,
  Key,
  BookOpen,
  Cpu,
  FlaskConical,
  LucideIcon,
} from "lucide-react";

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
  gemini_cli: number;
  qwen_code: number;
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
      { name: "Iflow", href: "/dashboard/accounts", anchorId: "iflow-accounts" },
      {
        name: "Gemini CLI",
        href: "/dashboard/accounts",
        anchorId: "gemini-cli-accounts",
      },
      { name: "Qwen Code", href: "/dashboard/accounts", anchorId: "qwen-code-accounts" },
    ],
  },
  { name: "API Keys", href: "/dashboard/api-keys", icon: Key },
  {
    name: "Models",
    href: "/dashboard/models",
    icon: Cpu,
    children: [
      { name: "OpenAI", href: "/dashboard/models", anchorId: "openai-models" },
      { name: "Claude", href: "/dashboard/models", anchorId: "claude-models" },
      { name: "Gemini", href: "/dashboard/models", anchorId: "gemini-models" },
    ],
  },
];

export const supportNavigation: NavItem[] = [
  { name: "Usage", href: "/dashboard/usage", icon: BookOpen },
  { name: "Playground", href: "/dashboard/playground", icon: FlaskConical },
];

export const navigation: NavItem[] = [...primaryNavigation, ...supportNavigation];
