import { randomUUID } from "node:crypto";

import { decrypt, encrypt } from "@opendum/crypto";
import {
  disableFailedAccount,
  getAccountCredentialsByID,
  getAccountOwnerUserID,
  getCustomProvider,
  listCustomProviderModels,
  listExpiringRefreshableAccounts,
  recordAccountError,
  updateRefreshedCredentials,
} from "@opendum/database/queries";
import {
  adaptForResponsesClient,
  compileCustomProvider,
  isCredentialRefresher,
  type CredentialRefresher,
  type Provider,
  type ProviderAccount,
  type RefreshedCredentials,
} from "@opendum/providers";

import { upsertErrorHistory } from "./error-history.js";
import { sleep } from "./helpers.js";
import {
  MAX_STORED_ERROR_LEN,
  REFRESH_FAIL_COUNT_PREFIX,
  REFRESH_FAIL_COUNT_TTL_SECONDS,
  REFRESH_MAX_CONSECUTIVE_FAILURES,
  TOKEN_REFRESH_LOCK_PREFIX,
  TOKEN_REFRESH_LOCK_TTL_SECONDS,
} from "./service-constants.js";
import type { ProxyDeps } from "./service-deps.js";
import {
  accountNeedsCredentialRefresh,
  isSyntheticProviderAccountId,
  parseRefreshErrorStatusCode,
  refreshBufferFor,
  withTimeout,
} from "./service-helpers.js";

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

async function refreshAccountCredentialsIfDue(
  deps: ProxyDeps,
  account: ProviderAccount,
  providerImpl: Provider,
  waitForLock: boolean
): Promise<{ credentials: string | null; account: ProviderAccount; error: Error | null }> {
  if (!isCredentialRefresher(providerImpl)) return { credentials: null, account, error: null };
  const refresher: CredentialRefresher = providerImpl;
  if (!accountNeedsCredentialRefresh(account, providerImpl)) return { credentials: null, account, error: null };
  if (!account.refreshToken) {
    if (waitForLock && account.expiresAt && account.expiresAt.getTime() < Date.now()) {
      return {
        credentials: null,
        account,
        error: new Error("provider account token has expired and cannot be refreshed"),
      };
    }
    return { credentials: null, account, error: null };
  }
  let refreshToken: string;
  try {
    refreshToken = decrypt(deps.secret, account.refreshToken);
  } catch {
    return { credentials: null, account, error: new Error("failed to decrypt refresh token") };
  }
  if (!refreshToken.trim()) return { credentials: null, account, error: null };

  const lock = await acquireRefreshLock(deps, account.id);
  if (!lock.acquired) {
    if (waitForLock && account.expiresAt && account.expiresAt.getTime() < Date.now()) {
      const waited = await waitForRefreshedAccount(deps, account);
      return waited;
    }
    return { credentials: null, account, error: null };
  }
  try {
    const current = await loadProviderAccountCredentialsByID(deps, account.id);
    if (!accountNeedsCredentialRefresh(current, providerImpl)) {
      try {
        const credentials = decrypt(deps.secret, current.accessToken ?? "");
        return { credentials, account: current, error: null };
      } catch {
        return { credentials: null, account: current, error: null };
      }
    }
    if (!current.refreshToken) return { credentials: null, account: current, error: null };
    refreshToken = decrypt(deps.secret, current.refreshToken);
    const refreshed = await refresher.refreshCredentials(refreshToken, current);
    const updated = await persistRefreshedCredentials(deps, current, refreshed);
    await clearRefreshFailures(deps, current.id);
    return { credentials: refreshed.accessToken, account: updated, error: null };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    await recordRefreshFailure(deps, account, err);
    return { credentials: null, account, error: err };
  } finally {
    await releaseRefreshLock(deps, account.id, lock.value);
  }
}

async function loadProviderAccountCredentialsByID(deps: ProxyDeps, accountId: string): Promise<ProviderAccount> {
  const row = await getAccountCredentialsByID(accountId, deps.database);
  if (!row) throw new Error("provider account not found");
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

async function persistRefreshedCredentials(
  deps: ProxyDeps,
  account: ProviderAccount,
  refreshed: RefreshedCredentials
): Promise<ProviderAccount> {
  if (!refreshed.accessToken || !refreshed.refreshToken || !refreshed.expiresAt) {
    throw new Error("provider token refresh returned incomplete credentials");
  }
  const storeAccessToken = refreshed.storeAccessToken?.trim() || refreshed.accessToken;
  const encryptedAccess = encrypt(deps.secret, storeAccessToken);
  const encryptedRefresh = encrypt(deps.secret, refreshed.refreshToken);
  const projectId = refreshed.projectId ? refreshed.projectId : account.projectId ?? null;
  let tier = account.tier ?? null;
  if (refreshed.tier) tier = refreshed.tier;
  if (refreshed.paidTier) tier = refreshed.paidTier;
  const email = refreshed.email ? refreshed.email : account.email ?? null;
  const accountId = refreshed.accountId ? refreshed.accountId : account.accountId ?? null;
  await updateRefreshedCredentials(
    {
      id: account.id,
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh,
      expiresAt: refreshed.expiresAt,
      projectId,
      tier,
      email,
      accountId,
    },
    deps.database
  );
  return {
    ...account,
    accessToken: encryptedAccess,
    refreshToken: encryptedRefresh,
    expiresAt: refreshed.expiresAt,
    projectId,
    tier,
    email,
    accountId,
  };
}

async function acquireRefreshLock(deps: ProxyDeps, accountId: string): Promise<{ value: string; acquired: boolean }> {
  const value = randomUUID();
  try {
    const result = await deps.redis.set(`${TOKEN_REFRESH_LOCK_PREFIX}${accountId}`, value, {
      NX: true,
      EX: TOKEN_REFRESH_LOCK_TTL_SECONDS,
    });
    return { value, acquired: Boolean(result) };
  } catch {
    return { value, acquired: true };
  }
}

async function releaseRefreshLock(deps: ProxyDeps, accountId: string, value: string): Promise<void> {
  try {
    await deps.redis.del(`${TOKEN_REFRESH_LOCK_PREFIX}${accountId}`);
  } catch {
    void value;
  }
}

async function waitForRefreshedAccount(
  deps: ProxyDeps,
  previous: ProviderAccount
): Promise<{ credentials: string | null; account: ProviderAccount; error: Error | null }> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await sleep(250);
    const current = await loadProviderAccountCredentialsByID(deps, previous.id);
    if (
      current.expiresAt &&
      current.expiresAt.getTime() > Date.now() &&
      (!previous.expiresAt || current.expiresAt.getTime() > previous.expiresAt.getTime())
    ) {
      try {
        return { credentials: decrypt(deps.secret, current.accessToken ?? ""), account: current, error: null };
      } catch {
        return { credentials: null, account: current, error: null };
      }
    }
  }
  return {
    credentials: null,
    account: previous,
    error: new Error("provider account token refresh is already in progress"),
  };
}

async function recordRefreshFailure(deps: ProxyDeps, account: ProviderAccount, error: Error): Promise<void> {
  if (!account.isActive) return;
  const now = new Date();
  const message =
    error.message.length > MAX_STORED_ERROR_LEN ? error.message.slice(0, MAX_STORED_ERROR_LEN) : error.message;
  const statusCode = parseRefreshErrorStatusCode(error);
  let failCount: number;
  try {
    failCount = await deps.redis.incr(`${REFRESH_FAIL_COUNT_PREFIX}${account.id}`);
    await deps.redis.expire(`${REFRESH_FAIL_COUNT_PREFIX}${account.id}`, REFRESH_FAIL_COUNT_TTL_SECONDS);
  } catch {
    failCount = 1;
  }
  await recordAccountError({ id: account.id, at: now, code: statusCode }, deps.database);
  const ownerUserId = account.userId || (await getAccountOwnerUserID(account.id, deps.database)) || "";
  if (ownerUserId) {
    await upsertErrorHistory(
      deps.redis,
      account.id,
      ownerUserId,
      null,
      statusCode,
      `Token refresh failed: ${message}`,
      now
    );
  }
  if (failCount >= REFRESH_MAX_CONSECUTIVE_FAILURES) {
    await disableFailedAccount({ id: account.id, status: "failed", at: now }, deps.database);
  }
}

async function clearRefreshFailures(deps: ProxyDeps, accountId: string): Promise<void> {
  try {
    await deps.redis.del(`${REFRESH_FAIL_COUNT_PREFIX}${accountId}`);
  } catch {
    return;
  }
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

export async function startTokenRefresher(
  deps: ProxyDeps,
  signal: AbortSignal,
  intervalMs: number
): Promise<void> {
  if (intervalMs <= 0) return;
  await runTokenRefresh(deps);
  const timer = setInterval(() => void runTokenRefresh(deps), intervalMs);
  timer.unref?.();
  signal.addEventListener("abort", () => clearInterval(timer));
}

async function runTokenRefresh(deps: ProxyDeps): Promise<void> {
  try {
    await refreshExpiringTokens(deps);
  } catch (error) {
    console.error("token refresh cycle failed", error);
  }
}

async function refreshExpiringTokens(deps: ProxyDeps): Promise<void> {
  const names = deps.providers.refreshableProviderNames();
  if (names.length === 0) return;
  const now = new Date();
  for (const name of names) {
    const providerImpl = deps.providers.get(name);
    if (!providerImpl) continue;
    const buffer = refreshBufferFor(providerImpl);
    let accounts: Awaited<ReturnType<typeof listExpiringRefreshableAccounts>>;
    try {
      accounts = await listExpiringRefreshableAccounts(
        { provider: name, now, expiresBefore: new Date(now.getTime() + buffer), batchLimit: 500 },
        deps.database
      );
    } catch (error) {
      console.error(`token refresh query failed for provider ${name}`, error);
      continue;
    }
    for (const row of accounts) {
      const account: ProviderAccount = {
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
      try {
        await refreshAccountCredentialsIfDue(deps, account, providerImpl, false);
      } catch {
        continue;
      }
    }
  }
}
