import type { Registry } from "@opendum/models/runtime";
import { ModelName } from "../../core/identity.js";
import type { ProviderAccount } from "../../types.js";
import { KIRO_REGION } from "../../endpoints.js";

export const API_BASE_URL = "https://q.%s.amazonaws.com/generateAssistantResponse";

export class KiroModel {
  static segment(model: string): string {
    return ModelName.segment(model);
  }

  static normalize(registry: Registry, model: string): string {
    const raw = KiroModel.segment(model);
    if (registry.supportsProvider(raw, "kiro")) return registry.upstream(raw, "kiro");
    if (raw.endsWith("-thinking")) {
      const base = raw.slice(0, -"-thinking".length);
      if (registry.supportsProvider(base, "kiro")) return registry.upstream(base, "kiro");
    }
    return registry.upstream(raw, "kiro");
  }

  static windowSize(model: string): number {
    return model.includes("-1m") ? 1_000_000 : 200_000;
  }

  static estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.floor((text.length + 3) / 4);
  }

  static truncate(value: string, maxLen: number): string {
    if (maxLen <= 0 || value.length <= maxLen) return value;
    return value.slice(0, maxLen);
  }
}

export class KiroTier {
  static normalize(rawType: string, subscriptionTitle: string): string {
    switch (rawType.trim().toUpperCase()) {
      case "Q_DEVELOPER_STANDALONE_FREE":
        return "free";
      case "Q_DEVELOPER_STANDALONE_POWER":
        return "power";
      case "Q_DEVELOPER_STANDALONE_PRO":
        return "pro";
      case "Q_DEVELOPER_STANDALONE_PRO_PLUS":
        return "pro-plus";
      case "Q_DEVELOPER_STANDALONE":
        return "standalone";
      default:
        break;
    }
    const title = subscriptionTitle.trim().toLowerCase();
    if (!title) return "";
    if (title.includes("pro+") || title.includes("pro plus")) return "pro-plus";
    if (title.includes("power")) return "power";
    if (title.includes("pro")) return "pro";
    if (title.includes("free")) return "free";
    return title.replace(/[_-]/g, " ").trim().split(/\s+/).join("-");
  }
}

export class KiroAccount {
  static regionFromArn(arn: string): string {
    const parts = arn.trim().split(":");
    if (parts.length >= 4 && parts[0] === "arn" && parts[3]) return parts[3];
    return "";
  }

  static apiUrl(account: ProviderAccount): string {
    let region = KIRO_REGION;
    if (account.accountId) {
      const extracted = KiroAccount.regionFromArn(account.accountId);
      if (extracted) region = extracted;
    }
    return API_BASE_URL.replace("%s", region);
  }
}
