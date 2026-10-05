import type { AuthResult, ModelValidationResult } from "@opendum/auth";
import { getCustomProvider } from "@opendum/database/queries";
import type { ProviderAccount } from "@opendum/providers";

import { stripImageContent } from "../streaming/content.ts";
import {
  buildAccountErrorMessage,
  codexUsageLimitDisabledUntil,
  endpointPath,
  isAntigravityResourceExhausted,
  prefixWithProvider,
  sanitizedProxyError,
  shouldRotate,
} from "../transport/errors.ts";
import { refundRoamingPoint, reserveRoamingPoint, type PointReservation } from "../metering/points.ts";
import { getNextAvailableAccount, getNextSharedAccount } from "../service-accounts.ts";
import { makeProviderRequest } from "../service-credentials.ts";
import type { ProxyDeps } from "../service-deps.ts";
import {
  bumpAccountRequestCountDeferred,
  logAccountError,
  logUsage,
  markAccountFailed,
  markAccountUsageLimited,
} from "../health/service-health.ts";
import type {
  AccountRotationFailure,
  AttemptResult,
  EndpointAdapter,
  ParsedEndpointRequest,
  RouteError,
} from "../types.ts";

type AccountErrorContext = {
  model: string;
  provider: string;
  endpoint: string;
  messages: unknown;
  parameters: Record<string, unknown>;
};

export async function modelAccountSelector(
  deps: ProxyDeps,
  modelParam: string,
  userId: string
): Promise<{ accountId: string; model: string } | null> {
  const index = modelParam.indexOf("/");
  if (index < 0) return null;
  const prefix = modelParam.slice(0, index).trim();
  const model = modelParam.slice(index + 1).trim();
  if (!prefix || !model || isKnownModelProviderPrefix(deps, prefix)) return null;
  if (userId) {
    const custom = await getCustomProvider(userId, prefix.toLowerCase(), deps.database);
    if (custom) return null;
  }
  return { accountId: prefix, model };
}

function isKnownModelProviderPrefix(deps: ProxyDeps, prefix: string): boolean {
  const provider = prefix.toLowerCase();
  if (deps.providers.has(provider)) return true;
  return deps.models.modelsForProvider(provider).length > 0;
}

export { validateForcedAccount } from "./account-validation.ts";

export async function executeWithAccountRotation(
  deps: ProxyDeps,
  cfg: EndpointAdapter,
  parsed: ParsedEndpointRequest,
  authResult: AuthResult,
  validation: ModelValidationResult,
  forced: ProviderAccount | null,
  startMs: number,
  sessionId: string
): Promise<AttemptResult | RouteError> {
  const tried: string[] = [];
  const sharedTried: string[] = [];
  const excludedProviders: string[] = [];
  let useShared = false;
  const recoverableFailures: AccountRotationFailure[] = [];
  let lastFailure: RouteError | null = null;
  let delayedFinalFailure: { account: ProviderAccount; statusCode: number; message: string } | null = null;
  let accountConfigured = false;

  for (;;) {
    let account: ProviderAccount | null = forced;
    let roaming: PointReservation | null = null;
    if (!account) {
      const selection = await nextAttemptAccount(
        deps,
        authResult,
        validation,
        tried,
        sharedTried,
        excludedProviders,
        useShared,
        sessionId
      );
      accountConfigured = accountConfigured || selection.configured;
      account = selection.account;
    }

    if (!account && !useShared && !forced && authResult.roamingEnabled) {
      useShared = true;
      continue;
    }

    if (!account) {
      if (lastFailure && delayedFinalFailure) {
        await markAccountFailed(
          deps,
          delayedFinalFailure.account.id,
          validation.model,
          delayedFinalFailure.statusCode,
          delayedFinalFailure.message
        );
      }
      if (tried.length + sharedTried.length === 0) {
        if (accountConfigured) {
          return {
            status: 503,
            message: "This model is temporarily unavailable. Please try again later.",
            type: "api_error",
          };
        }
        return {
          status: cfg.noAccountsStatusCode,
          message: "No active accounts available for this model. Please add an account in the web UI.",
          type: "configuration_error",
        };
      }
      if (lastFailure) return lastFailure;
      return { status: 503, message: "No available accounts for this request.", type: "api_error" };
    }

    if (useShared && !forced) {
      const reserved = await reserveRoamingPoint(deps.database, authResult.userId, validation.model);
      if (!reserved) {
        return {
          status: 402,
          message: "Insufficient points. Please add more points to continue.",
          type: "insufficient_quota",
          code: "insufficient_points",
        };
      }
      roaming = reserved;
    }

    if (useShared) sharedTried.push(account.id);
    else tried.push(account.id);

    const payload = cfg.build(parsed, validation.model, parsed.stream, sessionId);
    if (validation.vision === null || validation.vision === undefined) {
      if (!deps.models.isVisionModel(validation.model)) stripImageContent(payload);
    } else if (!validation.vision) {
      stripImageContent(payload);
    }

    const requestStartMs = Date.now();
    let upstreamFirstResponseMs = 0;
    let response: Response;
    try {
      response = await makeProviderRequest(deps, account, payload, parsed.stream, () => {
        if (upstreamFirstResponseMs === 0) upstreamFirstResponseMs = Date.now();
      });
    } catch (error) {
      delayedFinalFailure = null;
      const status = 500;
      const message = error instanceof Error ? error.message : String(error);
      const detailed = buildAccountErrorMessage(message, errorContext(cfg, validation, parsed, account.provider));
      const failedAt = await markAccountFailed(deps, account.id, validation.model, status, detailed);
      await logUsage(deps, authResult, account, validation, status, Date.now() - startMs);
      lastFailure = {
        status,
        message: prefixWithProvider(account.provider, message),
        type: "api_error",
        accountId: account.id,
      };
      if (roaming) await refundRoamingPoint(deps.database, roaming);
      if (!forced) {
        recoverableFailures.push({ accountId: account.id, failedAt });
        continue;
      }
      return lastFailure;
    }

    if (upstreamFirstResponseMs === 0) upstreamFirstResponseMs = Date.now();

    if (response.status < 200 || response.status >= 300) {
      const bodyText = (await response.text()).slice(0, 1 << 20);
      let failedAt: Date | null = null;
      delayedFinalFailure = null;
      const badRequestFromProvider = response.status === 400;
      const fallbackAcrossProviders = badRequestFromProvider && !forced && validation.provider === null;
      const detailed = buildAccountErrorMessage(
        bodyText,
        errorContext(cfg, validation, parsed, account.provider)
      );
      if (response.status !== 408 && !badRequestFromProvider) {
        if (!forced && isAntigravityResourceExhausted(account.provider, response.status, bodyText)) {
          delayedFinalFailure = { account, statusCode: response.status, message: detailed };
          await logAccountError(deps, account.id, account.userId, validation.model, response.status, detailed);
        } else {
          failedAt = await markAccountFailed(deps, account.id, validation.model, response.status, detailed);
          const disabledUntil = codexUsageLimitDisabledUntil(account.provider, response.status, bodyText, failedAt);
          if (disabledUntil) {
            await markAccountUsageLimited(deps, account.id, validation.model, disabledUntil, failedAt);
          }
        }
      } else {
        await logAccountError(deps, account.id, account.userId, validation.model, response.status, detailed);
      }
      await logUsage(deps, authResult, account, validation, response.status, Date.now() - startMs);
      const sanitized = sanitizedProxyError(response.status, bodyText);
      lastFailure = {
        status: response.status,
        message: prefixWithProvider(account.provider, sanitized.message),
        type: sanitized.type,
        accountId: account.id,
      };
      if (roaming) await refundRoamingPoint(deps.database, roaming);
      if (fallbackAcrossProviders) {
        if (!excludedProviders.includes(account.provider)) excludedProviders.push(account.provider);
        continue;
      }
      if (shouldRotate(response.status) && !forced) {
        if (failedAt) recoverableFailures.push({ accountId: account.id, failedAt });
        continue;
      }
      return lastFailure;
    }

    if (forced) void bumpAccountRequestCountDeferred(deps, account.id);
    return {
      account,
      response,
      requestStartMs,
      upstreamFirstResponseMs,
      rotationFailures: recoverableFailures,
      roaming,
    };
  }
}

function errorContext(
  cfg: EndpointAdapter,
  validation: ModelValidationResult,
  parsed: ParsedEndpointRequest,
  provider: string
): AccountErrorContext {
  return {
    model: validation.model,
    provider,
    endpoint: endpointPath(cfg.endpoint),
    messages: parsed.messagesForError,
    parameters: parsed.paramsForError,
  };
}

async function nextAttemptAccount(
  deps: ProxyDeps,
  authResult: AuthResult,
  validation: ModelValidationResult,
  tried: string[],
  sharedTried: string[],
  excludedProviders: string[],
  useShared: boolean,
  sessionId: string
): Promise<{ account: ProviderAccount | null; configured: boolean }> {
  if (useShared) {
    const result = await getNextSharedAccount(
      deps,
      authResult.userId,
      validation.model,
      validation.provider,
      sharedTried,
      excludedProviders
    );
    return { account: result.account, configured: result.configured };
  }
  return getNextAvailableAccount(
    deps,
    authResult.userId,
    validation.model,
    validation.provider,
    tried,
    excludedProviders,
    { mode: authResult.accountAccessMode, accounts: authResult.accountAccessList },
    sessionId
  );
}
