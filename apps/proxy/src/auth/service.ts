import { eq, sql } from "drizzle-orm";
import type { RedisClientType } from "redis";
import {
  db,
  proxyApiKey,
  disabledModel,
  providerAccount,
  providerAccountDisabledModel,
  userSharingSetting,
  hashString,
} from "@opendum/database";
import type { ModelRegistry } from "@opendum/ai";

export interface ValidateApiKeyResult {
  valid: boolean;
  error?: string;
  userId?: string;
  apiKeyId?: string;
  modelAccessMode?: string;
  modelAccessList?: string[];
  accountAccessMode?: string;
  accountAccessList?: string[];
  roamingEnabled?: boolean;
}

export interface AccountModelAvailability {
  ownedAccountsByProvider: Map<string, string[]>;
  sharedAccountsByProvider: Map<string, string[]>;
  ownedDisabledModelsByAccount: Map<string, Set<string>>;
  sharedDisabledModelsByAccount: Map<string, Set<string>>;
}

export class AuthService {
  constructor(
    private redis: RedisClientType,
    private registry: ModelRegistry
  ) {}

  async validateAPIKey(authHeader: string): Promise<ValidateApiKeyResult> {
    const rawKey = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!rawKey) {
      return { valid: false, error: "Missing API key." };
    }

    const keyHash = hashString(rawKey);
    const cacheKey = `opendum:api_key:${keyHash}`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch {
      // Redis fallback
    }

    const rows = await db
      .select()
      .from(proxyApiKey)
      .where(eq(proxyApiKey.keyHash, keyHash))
      .limit(1);

    if (rows.length === 0) {
      return { valid: false, error: "Invalid API key." };
    }

    const record = rows[0]!;
    if (!record.isActive) {
      return { valid: false, error: "API key is disabled." };
    }

    if (record.expiresAt && new Date() > record.expiresAt) {
      return { valid: false, error: "API key is expired." };
    }

    const result: ValidateApiKeyResult = {
      valid: true,
      userId: record.userId,
      apiKeyId: record.id,
      modelAccessMode: record.modelAccessMode,
      modelAccessList: record.modelAccessList ?? [],
      accountAccessMode: record.accountAccessMode,
      accountAccessList: record.accountAccessList ?? [],
      roamingEnabled: record.roamingEnabled,
    };

    try {
      await this.redis.set(cacheKey, JSON.stringify(result), { EX: 300 });
      // Update lastUsedAt asynchronously
      db.update(proxyApiKey)
        .set({ lastUsedAt: new Date() })
        .where(eq(proxyApiKey.id, record.id))
        .catch(() => undefined);
    } catch {
      // Ignore
    }

    return result;
  }

  async disabledModelSetForUser(userId: string): Promise<Set<string>> {
    const rows = await db
      .select({ model: disabledModel.model })
      .from(disabledModel)
      .where(eq(disabledModel.userId, userId));

    return new Set(rows.map((r) => this.registry.resolveAlias(r.model)));
  }

  async getAccountModelAvailabilityWithSharing(
    userId: string,
    roamingEnabled: boolean
  ): Promise<AccountModelAvailability> {
    const availability: AccountModelAvailability = {
      ownedAccountsByProvider: new Map(),
      sharedAccountsByProvider: new Map(),
      ownedDisabledModelsByAccount: new Map(),
      sharedDisabledModelsByAccount: new Map(),
    };

    const owned = await db
      .select()
      .from(providerAccount)
      .where(
        sql`${providerAccount.userId} = ${userId} AND ${providerAccount.isActive} = true`
      );

    for (const acc of owned) {
      const list = availability.ownedAccountsByProvider.get(acc.provider) || [];
      list.push(acc.id);
      availability.ownedAccountsByProvider.set(acc.provider, list);
    }

    if (roamingEnabled) {
      const shared = await db
        .select({
          account: providerAccount,
        })
        .from(providerAccount)
        .innerJoin(
          userSharingSetting,
          eq(userSharingSetting.userId, providerAccount.userId)
        )
        .where(
          sql`${providerAccount.userId} != ${userId} AND ${providerAccount.isActive} = true AND ${userSharingSetting.enabled} = true`
        );

      for (const row of shared) {
        const acc = row.account;
        const list =
          availability.sharedAccountsByProvider.get(acc.provider) || [];
        list.push(acc.id);
        availability.sharedAccountsByProvider.set(acc.provider, list);
      }
    }

    const allAccountIds = [
      ...owned.map((a) => a.id),
      ...Array.from(availability.sharedAccountsByProvider.values()).flat(),
    ];

    if (allAccountIds.length > 0) {
      const disabledModels = await db
        .select()
        .from(providerAccountDisabledModel)
        .where(
          sql`${providerAccountDisabledModel.providerAccountId} IN ${allAccountIds}`
        );

      for (const d of disabledModels) {
        const canonical = this.registry.resolveAlias(d.model);
        if (availability.ownedAccountsByProvider.has(d.providerAccountId)) {
          let s = availability.ownedDisabledModelsByAccount.get(
            d.providerAccountId
          );
          if (!s) {
            s = new Set();
            availability.ownedDisabledModelsByAccount.set(
              d.providerAccountId,
              s
            );
          }
          s.add(canonical);
        } else {
          let s = availability.sharedDisabledModelsByAccount.get(
            d.providerAccountId
          );
          if (!s) {
            s = new Set();
            availability.sharedDisabledModelsByAccount.set(
              d.providerAccountId,
              s
            );
          }
          s.add(canonical);
        }
      }
    }

    return availability;
  }

  isModelUsableByAccounts(
    model: string,
    availability: AccountModelAvailability
  ): boolean {
    const canonical = this.registry.resolveAlias(model);
    const providers = this.registry.getProvidersForModel(canonical);

    for (const p of providers) {
      const accounts = availability.ownedAccountsByProvider.get(p);
      if (accounts && accounts.length > 0) {
        return true;
      }
    }
    return false;
  }

  isModelUsableBySharedAccounts(
    model: string,
    availability: AccountModelAvailability
  ): boolean {
    const canonical = this.registry.resolveAlias(model);
    const providers = this.registry.getProvidersForModel(canonical);

    for (const p of providers) {
      const accounts = availability.sharedAccountsByProvider.get(p);
      if (accounts && accounts.length > 0) {
        return true;
      }
    }
    return false;
  }
}
