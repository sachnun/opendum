import { and, count as countFn, eq } from "drizzle-orm";
import { Effect, Result } from "effect";

import type { CodexSessionInput, ExchangeInput, AuthUrlInput, DeviceAuthInput, DevicePollInput } from "@opendum/providers/contract";
import { db, providerAccount } from "@opendum/database";
import { publishAccounts } from "@opendum/api/web/events/bus";
import { encrypt } from "@opendum/api/web/lib/encryption";
import { authRuntime } from "@opendum/api/web/lib/providers/runtime";
import { codexAuth } from "@opendum/providers/auth/codex/index";
import { deviceFlows, oauthFlows, optionsFor, parseCallback, validateContext, type OAuthOptions } from "@opendum/providers/auth/flows";
import { isFailed, isPending } from "@opendum/providers/auth/response";
import type { OAuthResult } from "@opendum/providers/auth/result";
import type { AuthProvider } from "@opendum/providers/provider-accounts";
import type { DeviceProviderKey } from "@opendum/providers/provider-accounts";
import { clearFails } from "@opendum/api/web/lib/proxy/auth";
import type { ActionResult } from "@opendum/api/web/utils/api";
import { fromPromise } from "@opendum/api/web/lib/task";
import { ServiceFailure, badRequest, internal } from "@opendum/api/web/errors";
import { trackProviderEmail } from "@opendum/api/web/services/points";

const OAUTH_PROVIDERS = oauthFlows(authRuntime);
const DEVICE_PROVIDERS = deviceFlows(authRuntime);

type ProviderAccountKey = AuthProvider | DeviceProviderKey;

function encryptRefresh(refreshToken: string | undefined): string {
  return refreshToken ? encrypt(refreshToken) : "";
}

function accountValues(oauthResult: OAuthResult, email: string, accountId: string | null) {
  return {
    accessToken: encrypt(oauthResult.accessToken),
    refreshToken: encryptRefresh(oauthResult.refreshToken),
    expiresAt: oauthResult.expiresAt,
    email,
    ...(oauthResult.projectId ? { projectId: oauthResult.projectId } : {}),
    ...(oauthResult.tier ? { tier: oauthResult.tier } : {}),
    ...(accountId ? { accountId } : {}),
    isActive: true,
    disabledUntil: null,
  };
}

type AccountFilter = { email: string } | { accountId: string };

function findAccount(userId: string, provider: ProviderAccountKey, filter: AccountFilter) {
  const match =
    "email" in filter
      ? eq(providerAccount.email, filter.email)
      : eq(providerAccount.accountId, filter.accountId);
  return fromPromise(
    () =>
      db
        .select({ id: providerAccount.id, email: providerAccount.email })
        .from(providerAccount)
        .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider), match))
        .limit(1),
    "Failed to load provider account"
  );
}

const upsertAccount = Effect.fn("accountAuth.upsertAccount")(function* (
  userId: string,
  provider: ProviderAccountKey,
  label: string,
  oauthResult: OAuthResult,
  options: OAuthOptions = {}
) {
  const email = options.email || oauthResult.email || `${provider}-${Date.now()}`;
  const accountId = options.accountId ?? oauthResult.accountId ?? null;
  const foundByEmail = yield* findAccount(userId, provider, { email });
  const foundByAccount =
    !foundByEmail[0] && accountId && options.dedupeByAccountId
      ? yield* findAccount(userId, provider, { accountId })
      : [];
  const existingAccount = foundByEmail[0] ?? foundByAccount[0] ?? null;

  if (existingAccount) {
    const resolvedEmail =
      oauthResult.email && email === oauthResult.email
        ? oauthResult.email
        : existingAccount.email || email;
    yield* fromPromise(
      () =>
        db
          .update(providerAccount)
          .set(accountValues(oauthResult, resolvedEmail, accountId))
          .where(eq(providerAccount.id, existingAccount.id)),
      "Failed to update provider account"
    );
    yield* clearFails(existingAccount.id);
    yield* trackProviderEmail(userId, resolvedEmail);
    publishAccounts(userId);
    return { email: resolvedEmail, isUpdate: true };
  }

  const countResult = yield* fromPromise(
    () =>
      db
        .select({ value: countFn() })
        .from(providerAccount)
        .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider))),
    "Failed to count provider accounts"
  );
  yield* fromPromise(
    () =>
      db.insert(providerAccount).values({
        userId,
        provider,
        name: `${label} ${(countResult[0]?.value ?? 0) + 1}`,
        projectId: oauthResult.projectId,
        tier: oauthResult.tier,
        accountId,
        ...accountValues(oauthResult, email, accountId),
      }),
    "Failed to create provider account"
  );
  yield* trackProviderEmail(userId, email);
  publishAccounts(userId);
  return { email, isUpdate: false };
});

export const authUrlFor = Effect.fn("accountAuth.getAuthUrl")(function* (input: AuthUrlInput) {
  const config = OAUTH_PROVIDERS[input.provider];
  const data = yield* config.buildAuthUrl().pipe(
    Effect.mapError((failure) => {
      const error = failure as { message?: string; cause?: unknown } | null;
      return internal(error?.message ?? "Account auth failed", error?.cause);
    })
  );
  return { success: true as const, data };
});

export const exchangeAccount = Effect.fn("accountAuth.exchangeAccount")(function* (
  userId: string,
  input: ExchangeInput
) {
  const config = OAUTH_PROVIDERS[input.provider];
  const parsed = parseCallback(input.callbackUrl, config.label);
  if ("message" in parsed) return { success: false as const, error: parsed.message };
  const invalidContext = validateContext(config, input, parsed.state);
  if (invalidContext) return { success: false as const, error: invalidContext.message };

  const oauthResult = yield* config.exchangeCode(parsed.code, input.codeVerifier);
  const data = yield* upsertAccount(
    userId,
    input.provider,
    config.label,
    oauthResult,
    optionsFor(input.provider, config, oauthResult)
  );
  return { success: true as const, data };
}) as (
  userId: string,
  input: ExchangeInput
) => Effect.Effect<ActionResult<{ email: string; isUpdate: boolean }>, ServiceFailure>;

export const connectCodex = Effect.fn("accountAuth.connectCodex")(function* (
  userId: string,
  input: CodexSessionInput
) {
  const parsedSession = codexAuth(authRuntime).sessionResult(input.sessionJson);
  if (Result.isFailure(parsedSession)) return yield* Effect.fail(badRequest(parsedSession.failure));
  const oauthResult = parsedSession.success;
  const data = yield* upsertAccount(
    userId,
    "codex",
    "Codex",
    oauthResult,
    optionsFor("codex", OAUTH_PROVIDERS.codex, oauthResult)
  );
  return { success: true as const, data };
}) as (
  userId: string,
  input: CodexSessionInput
) => Effect.Effect<ActionResult<{ email: string; isUpdate: boolean }>, ServiceFailure>;

export const initiateDeviceAuth = Effect.fn("accountAuth.initiateDeviceAuth")(function* (
  input: DeviceAuthInput
) {
  const config = DEVICE_PROVIDERS[input.provider];
  const data = yield* config.flow.startDeviceFlow().pipe(
    Effect.mapError((failure) => {
      const error = failure as { message?: string; cause?: unknown } | null;
      return internal(error?.message || "Account auth failed", error?.cause);
    })
  );
  return { success: true as const, data };
});

export const pollAuth = Effect.fn("accountAuth.pollAuth")(function* (
  userId: string,
  input: DevicePollInput
) {
  const config = DEVICE_PROVIDERS[input.provider];
  const result = yield* config.flow.pollDeviceAuth(input.deviceCode, input.userCode ?? "").pipe(
    Effect.mapError((failure) => {
      const error = failure as { message?: string; cause?: unknown } | null;
      return internal(error?.message || "Account auth failed", error?.cause);
    })
  );
  if (isPending(result)) {
    return {
      success: true as const,
      data: { status: "pending" as const, retryAfterSeconds: result.retryAfterSeconds },
    };
  }
  if (isFailed(result)) {
    return { success: true as const, data: { status: "error" as const, message: result.error } };
  }

  const oauthResult = result;
  const provider = input.provider;
  const email = oauthResult.email || `${config.emailPrefix}-${Date.now()}`;
  const saved = yield* upsertAccount(
    userId,
    provider,
    config.label,
    oauthResult,
    provider === "codex" ? optionsFor(provider, OAUTH_PROVIDERS.codex, oauthResult) : { email }
  );
  return { success: true as const, data: { status: "success" as const, ...saved } };
});
