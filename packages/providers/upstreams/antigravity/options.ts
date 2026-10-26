import type { OpendumRedis } from "@opendum/core/redis";
import type { Json } from "@opendum/providers/upstreams/antigravity/common";
import type { ProviderOptions } from "@opendum/providers/core/provider";

export type AccountInfo = {
  projectId: string;
  tier: string;
  paidTier: string;
  email: string;
};

export type AntigravityOptions = ProviderOptions & {
  redis?: OpendumRedis | null;
  persistAccountInfo?: (accountId: string, info: { projectId: string; tier: string; email: string }) => void;
};

export class CodeAssist {
  static metadata(): Json {
    return {
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    };
  }
}
