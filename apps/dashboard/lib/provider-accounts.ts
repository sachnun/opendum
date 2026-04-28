export type ProviderAccountKey =
  | "antigravity"
  | "cerebras"
  | "codex"
  | "copilot"
  | "gemini_cli"
  | "groq"
  | "kiro"
  | "nvidia_nim"
  | "ollama_cloud"
  | "kilo_code"
  | "openrouter"
  | "qwen_code"
  | "workers_ai";

export interface ProviderAccountDefinition {
  key: ProviderAccountKey;
  label: string;
}

export const PROVIDER_ACCOUNT_DEFINITIONS: ProviderAccountDefinition[] = [
  {
    key: "antigravity",
    label: "Antigravity",
  },
  {
    key: "codex",
    label: "Codex",
  },
  {
    key: "copilot",
    label: "Copilot",
  },
  {
    key: "gemini_cli",
    label: "Gemini CLI",
  },
  {
    key: "kiro",
    label: "Kiro",
  },
  {
    key: "qwen_code",
    label: "Qwen Code",
  },
  {
    key: "nvidia_nim",
    label: "Nvidia",
  },
  {
    key: "ollama_cloud",
    label: "Ollama Cloud",
  },
  {
    key: "openrouter",
    label: "OpenRouter",
  },
  {
    key: "groq",
    label: "Groq",
  },
  {
    key: "kilo_code",
    label: "Kilo Code",
  },
  {
    key: "cerebras",
    label: "Cerebras",
  },
  {
    key: "workers_ai",
    label: "Workers AI",
  },
];
