import { decrypt } from "@opendum/crypto";
import {
  getAccountCredentialsByID,
  getCustomProvider,
  listCustomProviderModels,
} from "@opendum/database/queries";
import {
  adaptForResponsesClient,
  compileCustomProvider,
  type Provider,
  type ProviderAccount,
} from "@opendum/providers";

import type { ProxyDeps } from "./service-deps.ts";
import { refreshAccountCredentialsIfDue } from "./service-refresh.ts";
import { isSyntheticProviderAccountId, withTimeout } from "./transport/service-helpers.ts";

export { startTokenRefresher } from "./service-refresh.ts";

export async function makeProviderRequest(
  deps: ProxyDeps,
  account: ProviderAccount,
  payload: Record<string, unknown>,
  stream: boolean,
  onUpstreamResponseStart: () => void
): Promise<Response> {
  let providerImpl = deps.providers.get(account.provider);
  if (!providerImpl) {
    providerImpl = (await customProviderForAccount(deps, account.userId, account.provider)) ?? undefined;
  }
  if (!providerImpl) {
    return new Response(
      JSON.stringify({ error: { message: `provider ${account.provider} is not implemented`, type: "api_error" } }),
      { status: 501, headers: { "Content-Type": "application/json" } }
    );
  }
  const authless = isSyntheticProviderAccountId(account.id);
  let credentials = "";
  let requestAccount = account;
  if (!authless) {
    const resolved = await credentialsForAccount(deps, account, providerImpl);
    credentials = resolved.credentials;
    requestAccount = resolved.account;
  }
  const request = providerImpl.makeRequest({
    account: requestAccount,
    credentials,
    body: payload,
    stream,
    onUpstreamResponseStart,
  });
  const response =
    !stream && deps.requestTimeoutMs > 0 ? await withTimeout(request, deps.requestTimeoutMs) : await request;
  if (response.status >= 200 && response.status < 300) {
    return adaptForResponsesClient(
      providerImpl as unknown as { responsesNative?(model: string): boolean },
      response,
      payload,
      stream
    );
  }
  return response;
}

async function credentialsForAccount(
  deps: ProxyDeps,
  account: ProviderAccount,
  providerImpl: Provider
): Promise<{ credentials: string; account: ProviderAccount }> {
  const requestAccount = await loadProviderAccountCredentials(deps, account);
  let credentials: string;
  try {
    credentials = decrypt(deps.secret, requestAccount.accessToken ?? "");
  } catch {
    credentials = requestAccount.accessToken ?? "";
  }
  const refreshed = await refreshAccountCredentialsIfDue(deps, requestAccount, providerImpl, true);
  if (refreshed.error) {
    if (requestAccount.expiresAt && requestAccount.expiresAt.getTime() < Date.now()) {
      throw refreshed.error;
    }
    return { credentials, account: requestAccount };
  }
  if (refreshed.credentials) return { credentials: refreshed.credentials, account: refreshed.account };
  return { credentials, account: requestAccount };
}

async function loadProviderAccountCredentials(
  deps: ProxyDeps,
  account: ProviderAccount
): Promise<ProviderAccount> {
  if (account.accessToken && account.refreshToken) return account;
  const row = await getAccountCredentialsByID(account.id, deps.database);
  if (!row) return account;
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
    accountId: row.accountId,
    projectId: row.projectId,
    tier: row.tier,
    email: row.email,
    isActive: row.isActive,
  };
}

export async function customProviderForAccount(
  deps: ProxyDeps,
  userId: string,
  provider: string
): Promise<Provider | null> {
  const custom = await getCustomProvider(userId, provider, deps.database);
  if (!custom) return null;
  const rows = await listCustomProviderModels(custom.id, deps.database);
  return compileCustomProvider({
    provider: { slug: custom.slug, baseUrl: custom.baseUrl, extraHeaders: custom.extraHeaders ?? null },
    models: rows.map((row) => ({
      modelId: row.modelId,
      upstream: row.upstream,
      authless: row.authless,
      customFlags: row.customFlags ?? null,
    })),
    transport: deps.providers.transport,
    fallback: null,
  });
}

export async function quotaCredentials(deps: ProxyDeps, account: ProviderAccount): Promise<string> {
  const providerImpl = deps.providers.get(account.provider);
  if (!providerImpl) {
    const loaded = await loadProviderAccountCredentials(deps, account);
    return decrypt(deps.secret, loaded.accessToken ?? "");
  }
  const resolved = await credentialsForAccount(deps, account, providerImpl);
  return resolved.credentials;
}


