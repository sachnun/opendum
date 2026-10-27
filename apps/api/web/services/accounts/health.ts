import { familyOf, ruleOf, providerSet } from "@opendum/api/web/lib/proxy/models";
import { compareEntries } from "@opendum/models/sort";
import {
  COOLDOWN_RECOVERY_RATIO,
  MODEL_DEGRADED_THRESHOLD,
  IDLE_DECAY_MS,
  UNHEALTHY_THRESHOLD,
  type HealthRow,
  type AccountRow,
} from "@opendum/api/web/services/accounts/types";
import { INDICATOR_WEIGHT, type ProviderAccountIndicator } from "@opendum/api/web/services/account-stats";

export class Clock {
  static ms(value: Date | string | null | undefined): number | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    const time = date.getTime();
    return Number.isNaN(time) ? null : time;
  }
}

export class AccountState {
  static active(
    account: { isActive: boolean; disabledUntil: Date | string | null },
    now = new Date()
  ): boolean {
    if (!account.isActive) return false;
    if (!account.disabledUntil) return true;
    const disabledUntil =
      account.disabledUntil instanceof Date ? account.disabledUntil : new Date(account.disabledUntil);
    return Number.isNaN(disabledUntil.getTime()) || disabledUntil <= now;
  }

  static withActive<T extends { isActive: boolean; disabledUntil: Date | string | null }>(
    account: T,
    now = new Date()
  ): T {
    return { ...account, isActive: AccountState.active(account, now) };
  }

  static hasCooldown(
    account: { status: string; disabledUntil: Date | string | null },
    now = new Date()
  ): boolean {
    if (account.status !== "failed") return false;
    const disabledUntilMs = Clock.ms(account.disabledUntil);
    return !disabledUntilMs || disabledUntilMs > now.getTime();
  }

  static cooldownRecoveryIds(
    accounts: Array<{ id: string; status: string; disabledUntil: Date | string | null }>,
    now = new Date()
  ): Set<string> {
    return new Set(
      accounts.flatMap((account) => {
        if (account.status !== "failed") return [];
        const disabledUntilMs = Clock.ms(account.disabledUntil);
        return disabledUntilMs && disabledUntilMs <= now.getTime() ? [account.id] : [];
      })
    );
  }
}

export class Tier {
  static normalize(tier: string | null | undefined): string | null {
    if (!tier) return null;
    const normalized = tier.trim().toLowerCase().replace(/_/g, "-");
    if (normalized === "pro-plus" || normalized === "proplus") return "pro+";
    if (normalized === "free-tier") return "free";
    if (
      normalized === "education" ||
      normalized === "educational" ||
      normalized === "edu" ||
      normalized === "free-educational-quota"
    ) {
      return "student";
    }
    return normalized || null;
  }

  static canAccess(
    accountTier: string | null | undefined,
    model: string,
    provider: string
  ): boolean {
    const accessRule = ruleOf(model, provider);
    if (!accessRule?.allowedTiers?.length && !accessRule?.minTier) return true;

    const normalizedAccountTier = Tier.normalize(accountTier);
    if (accessRule.allowedTiers?.length) {
      return accessRule.allowedTiers.some(
        (tier) => Tier.normalize(tier) === normalizedAccountTier
      );
    }

    const requiredTier = Tier.normalize(accessRule.minTier);
    return !requiredTier || requiredTier === "free" || normalizedAccountTier === requiredTier;
  }

  static accessibleByAccounts(
    model: string,
    provider: string,
    accounts: Array<{ tier: string | null }>
  ): boolean {
    if (accounts.length === 0) return true;
    const accessRule = ruleOf(model, provider);
    if (!accessRule?.allowedTiers?.length && !accessRule?.minTier) return true;
    return accounts.some((account) => Tier.canAccess(account.tier, model, provider));
  }

  static modelsFor(provider: string, tier: string | null | undefined): string[] {
    return ModelList.sort(
      Array.from(providerSet(provider)).filter((model) =>
        Tier.canAccess(tier, model, provider)
      )
    );
  }
}

export class ModelList {
  static sort(models: string[]): string[] {
    return [...models].sort((a, b) =>
      compareEntries({ id: a, family: familyOf(a) }, { id: b, family: familyOf(b) })
    );
  }
}

export class Health {
  static effectiveCount(
    row: {
      consecutiveErrors: number;
      unhealthyCountUpdatedAt?: Date | string | null;
      lastErrorAt?: Date | string | null;
      lastSuccessAt?: Date | string | null;
      updatedAt?: Date | string | null;
      createdAt?: Date | string | null;
    },
    now = new Date()
  ): number {
    if (row.consecutiveErrors <= 0) return 0;
    const lastRequestMs = Math.max(
      Clock.ms(row.unhealthyCountUpdatedAt) ?? 0,
      Clock.ms(row.lastErrorAt) ?? 0,
      Clock.ms(row.lastSuccessAt) ?? 0,
      Clock.ms(row.updatedAt) ?? 0,
      Clock.ms(row.createdAt) ?? 0
    );
    if (!lastRequestMs || lastRequestMs > now.getTime()) return row.consecutiveErrors;

    const decay = Math.floor((now.getTime() - lastRequestMs) / IDLE_DECAY_MS);
    return Math.max(0, row.consecutiveErrors - decay);
  }

  static status(unhealthyCount: number): string {
    return unhealthyCount >= MODEL_DEGRADED_THRESHOLD ? "degraded" : "active";
  }

  static recoveryCount(unhealthyCount: number): number {
    if (unhealthyCount <= 0) return 0;
    return Math.max(0, unhealthyCount - Math.round(unhealthyCount * COOLDOWN_RECOVERY_RATIO));
  }

  static recoverableStatus(code: number | null | undefined): boolean {
    if (!code) return false;
    return code === 408 || code === 429 || code >= 500;
  }

  static recovered(
    row: {
      lastErrorAt?: Date | string | null;
      lastSuccessAt?: Date | string | null;
      lastRecoveredAt?: Date | string | null;
      lastUsedAt?: Date | string | null;
    }
  ): boolean {
    const errorMs = Clock.ms(row.lastErrorAt);
    if (!errorMs) return false;
    const recoveredMs = Math.max(
      Clock.ms(row.lastSuccessAt) ?? 0,
      Clock.ms(row.lastRecoveredAt) ?? 0,
      Clock.ms(row.lastUsedAt) ?? 0
    );
    return recoveredMs > errorMs;
  }

  static actionable(
    row: {
      consecutiveErrors: number;
      lastErrorAt?: Date | string | null;
      lastErrorCode?: number | null;
      lastSuccessAt?: Date | string | null;
    }
  ): boolean {
    if (row.consecutiveErrors <= 0) return false;
    if (row.consecutiveErrors >= MODEL_DEGRADED_THRESHOLD) return true;
    return !(Health.recoverableStatus(row.lastErrorCode) && Health.recovered(row));
  }

  static indicator(account: AccountRow): ProviderAccountIndicator {
    const errorMs = Clock.ms(account.lastErrorAt);
    if (!errorMs) return "normal";
    if (!Health.recovered(account)) return "error";
    return Health.recoverableStatus(account.lastErrorCode) ? "normal" : "warning";
  }

  static withEffective<T extends HealthRow>(
    row: T,
    now = new Date(),
    applyCooldownRecovery = false
  ): T {
    const consecutiveErrors = applyCooldownRecovery
      ? Health.recoveryCount(Health.effectiveCount(row, now))
      : Health.effectiveCount(row, now);
    return { ...row, consecutiveErrors, status: Health.status(consecutiveErrors) };
  }

  static aggregate(
    healthRows: HealthRow[],
    now = new Date(),
    recoveryIds = new Set<string>()
  ): Record<string, { unhealthyCount: number; warningCount: number; lastErrorAt: Date | string | null; lastSuccessAt: Date | string | null }> {
    return healthRows
      .map((row) =>
        Health.withEffective(row, now, recoveryIds.has(row.providerAccountId))
      )
      .reduce<
        Record<
          string,
          {
            unhealthyCount: number;
            warningCount: number;
            lastErrorAt: Date | string | null;
            lastSuccessAt: Date | string | null;
          }
        >
      >((acc, row) => {
        const current = acc[row.providerAccountId] ?? {
          unhealthyCount: 0,
          warningCount: 0,
          lastErrorAt: null,
          lastSuccessAt: null,
        };
        current.unhealthyCount += row.consecutiveErrors;
        if (Health.actionable(row)) current.warningCount += row.consecutiveErrors;
        if ((Clock.ms(row.lastErrorAt) ?? 0) > (Clock.ms(current.lastErrorAt) ?? 0)) {
          current.lastErrorAt = row.lastErrorAt;
        }
        if ((Clock.ms(row.lastSuccessAt) ?? 0) > (Clock.ms(current.lastSuccessAt) ?? 0)) {
          current.lastSuccessAt = row.lastSuccessAt;
        }
        acc[row.providerAccountId] = current;
        return acc;
      }, {});
  }

  static pingSummaries(
    accounts: AccountRow[],
    healthById: Record<
      string,
      { unhealthyCount: number; warningCount: number; lastErrorAt: Date | string | null; lastSuccessAt: Date | string | null }
    > = {},
    now = new Date(),
    providers: readonly string[] = []
  ): Record<string, { connected: number; active: number; indicator: ProviderAccountIndicator }> {
    const summaries = Object.fromEntries(
      providers.map((provider) => [
        provider,
        { connected: 0, active: 0, indicator: "normal" as ProviderAccountIndicator },
      ])
    ) as Record<string, { connected: number; active: number; indicator: ProviderAccountIndicator }>;

    for (const account of accounts) {
      summaries[account.provider] ??= {
        connected: 0,
        active: 0,
        indicator: "normal",
      };
      const summary = summaries[account.provider];
      summary.connected += 1;

      if (!AccountState.active(account, now)) continue;

      summary.active += 1;
      const health = healthById[account.id];
      const unhealthyCount = health?.unhealthyCount ?? account.consecutiveErrors;
      const warningCount = health?.warningCount ?? account.consecutiveErrors;
      const indicator =
        account.status === "failed" || unhealthyCount >= UNHEALTHY_THRESHOLD
          ? "error"
          : warningCount > 0
            ? "warning"
            : Health.indicator(account);
      if (INDICATOR_WEIGHT[indicator] > INDICATOR_WEIGHT[summary.indicator]) {
        summary.indicator = indicator;
      }
    }

    return summaries;
  }
}
