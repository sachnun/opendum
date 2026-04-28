import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { providerAccount } from "../db/schema.js";
import { decrypt, encrypt } from "../encryption.js";
import {
  getProvider,
  isValidProvider,
} from "../proxy/providers/registry.js";
import {
  OAUTH_PROVIDER_NAMES,
  type ProviderNameType,
} from "../proxy/providers/types.js";

export interface RefreshResult {
  accountId: string;
  provider: string;
  email: string | null;
  status: "refreshed" | "failed" | "skipped";
  error?: string;
}

export interface RefreshTokensSummary {
  total: number;
  refreshed: number;
  failed: number;
  skipped: number;
  duration: number;
}

export interface RefreshTokensResponse {
  success: boolean;
  summary: RefreshTokensSummary;
  results: RefreshResult[];
}

const REFRESH_THRESHOLD_SECONDS = 7200;

export async function refreshTokens(): Promise<RefreshTokensResponse> {
  const startTime = Date.now();
  const results: RefreshResult[] = [];

  const accounts = await db
    .select({
      id: providerAccount.id,
      provider: providerAccount.provider,
      email: providerAccount.email,
      refreshToken: providerAccount.refreshToken,
      accessToken: providerAccount.accessToken,
      expiresAt: providerAccount.expiresAt,
      apiKey: providerAccount.apiKey,
      projectId: providerAccount.projectId,
      tier: providerAccount.tier,
    })
    .from(providerAccount)
    .where(
      and(
        eq(providerAccount.isActive, true),
        inArray(providerAccount.provider, [...OAUTH_PROVIDER_NAMES]),
      ),
    );

  const thresholdTime = new Date(Date.now() + REFRESH_THRESHOLD_SECONDS * 1000);

  for (const account of accounts) {
    if (account.expiresAt > thresholdTime) {
      results.push({
        accountId: account.id,
        provider: account.provider,
        email: account.email,
        status: "skipped",
      });
      continue;
    }

    if (!isValidProvider(account.provider)) {
      results.push({
        accountId: account.id,
        provider: account.provider,
        email: account.email,
        status: "failed",
        error: `Unknown provider: ${account.provider}`,
      });
      continue;
    }

    try {
      const provider = await getProvider(account.provider as ProviderNameType);
      const refreshTokenValue = decrypt(account.refreshToken);
      const newTokens = await provider.refreshToken(refreshTokenValue);

      const updateData: {
        accessToken: string;
        refreshToken: string;
        expiresAt: Date;
        email?: string;
        apiKey?: string;
        projectId?: string;
        tier?: string;
      } = {
        accessToken: encrypt(newTokens.accessToken),
        refreshToken: encrypt(newTokens.refreshToken),
        expiresAt: newTokens.expiresAt,
      };

      if (newTokens.email) {
        updateData.email = newTokens.email;
      }
      if (newTokens.apiKey) {
        updateData.apiKey = encrypt(newTokens.apiKey);
      }
      if (newTokens.projectId) {
        updateData.projectId = newTokens.projectId;
      }
      if (newTokens.tier) {
        updateData.tier = newTokens.tier;
      }

      await db
        .update(providerAccount)
        .set(updateData)
        .where(eq(providerAccount.id, account.id));

      results.push({
        accountId: account.id,
        provider: account.provider,
        email: account.email,
        status: "refreshed",
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      results.push({
        accountId: account.id,
        provider: account.provider,
        email: account.email,
        status: "failed",
        error: errorMessage,
      });
    }
  }

  return {
    success: true,
    summary: {
      total: results.length,
      refreshed: results.filter((result) => result.status === "refreshed").length,
      failed: results.filter((result) => result.status === "failed").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      duration: Date.now() - startTime,
    },
    results,
  };
}
