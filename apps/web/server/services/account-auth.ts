import { and, count as countFn, eq } from "drizzle-orm";
import { z } from "zod";

import { db, providerAccount } from "@opendum/database";
import { encrypt } from "~~/server/lib/encryption";
import { clearRefreshFailCount } from "~~/server/lib/proxy/auth";
import type { OAuthResult } from "~~/server/lib/providers/types";
import { PROVIDER_CONNECTORS, type AccountConnector } from "~~/server/lib/providers";
import { DEVICE_PROVIDER_KEYS, OAUTH_PROVIDER_KEYS, type DeviceProviderKey, type OAuthProviderKey } from "~~/lib/provider-accounts";
import type { ActionResult } from "~~/server/utils/api";
import { trackProviderEmail } from "./points";

export const getAuthUrlInputSchema = z.object({ provider: z.enum([...OAUTH_PROVIDER_KEYS]) });
export const exchangeOAuthInputSchema = z.object({ provider: z.enum([...OAUTH_PROVIDER_KEYS]), callbackUrl: z.string(), state: z.string().nullable().optional(), codeVerifier: z.string().nullable().optional() });
export const initiateDeviceAuthInputSchema = z.object({ provider: z.enum([...DEVICE_PROVIDER_KEYS]), method: z.string().optional() });
export const pollDeviceAuthInputSchema = z.object({ provider: z.enum([...DEVICE_PROVIDER_KEYS]), deviceCode: z.string(), userCode: z.string().optional(), codeVerifier: z.string().optional(), method: z.string().optional(), machineId: z.string().optional() });
export const connectCodexSessionInputSchema = z.object({ sessionJson: z.string().min(1, "Session JSON is required") });

type ProviderAccountKey = OAuthProviderKey | DeviceProviderKey;
type OAuthAccountOptions = {
  email?: string;
  accountId?: string | null;
  dedupeByAccountId?: boolean;
};

function parseOAuthCallbackUrl(callbackUrl: string, providerLabel: string): ActionResult<{ code: string; state: string | null }> {
  if (!callbackUrl || typeof callbackUrl !== "string") return { success: false, error: "Callback URL is required" };

  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return { success: false, error: "Invalid URL format" };
  }

  const error = url.searchParams.get("error");
  if (error) return { success: false, error: `${providerLabel} OAuth error: ${url.searchParams.get("error_description") || error}` };

  const code = url.searchParams.get("code");
  if (!code) return { success: false, error: "No authorization code found in URL. Make sure you copied the complete URL from your browser." };
  return { success: true, data: { code, state: url.searchParams.get("state") } };
}

function encryptOptionalRefreshToken(refreshToken: string | undefined): string {
  return refreshToken ? encrypt(refreshToken) : "";
}

async function upsertOAuthAccount(userId: string, provider: ProviderAccountKey, label: string, oauthResult: OAuthResult, options: OAuthAccountOptions = {}): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const email = options.email || oauthResult.email || `${provider}-${Date.now()}`;
  const accountId = options.accountId ?? oauthResult.accountId ?? null;
  const [foundByEmail] = await db.select({ id: providerAccount.id, email: providerAccount.email }).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider), eq(providerAccount.email, email))).limit(1);
  const [foundByAccountId] = !foundByEmail && accountId && options.dedupeByAccountId
    ? await db.select({ id: providerAccount.id, email: providerAccount.email }).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider), eq(providerAccount.accountId, accountId))).limit(1)
    : [];
  const existingAccount = foundByEmail ?? foundByAccountId ?? null;

  if (existingAccount) {
    const resolvedEmail = oauthResult.email && email === oauthResult.email ? oauthResult.email : existingAccount.email || email;
    await db.update(providerAccount).set({ accessToken: encrypt(oauthResult.accessToken), refreshToken: encryptOptionalRefreshToken(oauthResult.refreshToken), expiresAt: oauthResult.expiresAt, email: resolvedEmail, ...(oauthResult.projectId ? { projectId: oauthResult.projectId } : {}), ...(oauthResult.tier ? { tier: oauthResult.tier } : {}), ...(accountId ? { accountId } : {}), isActive: true, disabledUntil: null }).where(eq(providerAccount.id, existingAccount.id));
    await clearRefreshFailCount(existingAccount.id);
    await trackProviderEmail(userId, resolvedEmail);
    return { success: true, data: { email: resolvedEmail, isUpdate: true } };
  }

  const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider)));
  await db.insert(providerAccount).values({ userId, provider, name: `${label} ${(countResult?.value ?? 0) + 1}`, accessToken: encrypt(oauthResult.accessToken), refreshToken: encryptOptionalRefreshToken(oauthResult.refreshToken), expiresAt: oauthResult.expiresAt, email, projectId: oauthResult.projectId, tier: oauthResult.tier, accountId, isActive: true });
  await trackProviderEmail(userId, email);
  return { success: true, data: { email, isUpdate: false } };
}

function validateOAuthContext(connector: AccountConnector, input: z.infer<typeof exchangeOAuthInputSchema>, parsedState: string | null): ActionResult<void> | null {
  if (!connector.requiresCodeVerifier) return null;
  if (parsedState !== input.state) return { success: false, error: "Invalid OAuth state. Please restart authentication." };
  if (!input.codeVerifier) return { success: false, error: "Missing authentication context. Please restart authentication." };
  return null;
}

export async function getAccountAuthUrl(input: z.infer<typeof getAuthUrlInputSchema>) {
  try {
    const connector = PROVIDER_CONNECTORS[input.provider];
    if (!connector?.buildAuthUrl) throw new Error(`${input.provider} does not support OAuth authorization`);
    return { success: true, data: await connector.buildAuthUrl() } as const;
  } catch (error) {
    console.error("Failed to build provider auth URL:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to build login URL" } as const;
  }
}

export async function exchangeOAuthAccount(userId: string, input: z.infer<typeof exchangeOAuthInputSchema>) {
  try {
    const connector = PROVIDER_CONNECTORS[input.provider];
    if (!connector?.exchangeCode) throw new Error(`${input.provider} does not support OAuth exchange`);
    const parsedUrl = parseOAuthCallbackUrl(input.callbackUrl, connector.label);
    if (!parsedUrl.success) return parsedUrl;
    const invalidContext = validateOAuthContext(connector, input, parsedUrl.data.state);
    if (invalidContext) return invalidContext;

    const oauthResult = await connector.exchangeCode(parsedUrl.data.code, input.codeVerifier);
    return await upsertOAuthAccount(userId, input.provider, connector.label, oauthResult, connector.accountOptions?.(oauthResult));
  } catch (error) {
    console.error("Failed to exchange provider OAuth code:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to connect account" } as const;
  }
}

export async function connectCodexSessionAccount(userId: string, input: z.infer<typeof connectCodexSessionInputSchema>) {
  try {
    const connector = PROVIDER_CONNECTORS.codex;
    if (!connector?.connectSession) throw new Error("Codex session connection is not available");
    const oauthResult = connector.connectSession(input.sessionJson);
    return await upsertOAuthAccount(userId, "codex", connector.label, oauthResult, connector.accountOptions?.(oauthResult));
  } catch (error) {
    console.error("Failed to connect Codex ChatGPT session:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to connect account" } as const;
  }
}

export async function initiateDeviceAuth(input: z.infer<typeof initiateDeviceAuthInputSchema>) {
  try {
    const connector = PROVIDER_CONNECTORS[input.provider];
    if (!connector?.device) throw new Error(`${input.provider} does not support device authorization`);
    return { success: true, data: await connector.device.initiate() } as const;
  } catch (error) {
    console.error("Failed to initiate provider device auth:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to start device login" } as const;
  }
}

export async function pollDeviceAuth(userId: string, input: z.infer<typeof pollDeviceAuthInputSchema>) {
  try {
    const connector = PROVIDER_CONNECTORS[input.provider];
    if (!connector?.device) throw new Error(`${input.provider} does not support device authorization`);
    const result = await connector.device.poll(input);
    if ("pending" in result) return { success: true, data: { status: "pending" as const, retryAfterSeconds: "retryAfterSeconds" in result ? result.retryAfterSeconds : undefined } } as const;
    if ("error" in result) return { success: true, data: { status: "error" as const, message: result.error } } as const;

    const email = result.email || `${connector.device.emailPrefix}-${Date.now()}`;
    const saved = await upsertOAuthAccount(userId, input.provider, connector.label, result, connector.accountOptions?.(result) ?? { email });
    if (!saved.success) return saved;
    return { success: true, data: { status: "success" as const, ...saved.data } } as const;
  } catch (error) {
    console.error("Failed to poll provider device auth:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to connect account" } as const;
  }
}
