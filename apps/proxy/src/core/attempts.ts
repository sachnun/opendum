import type { AuthResult, ModelValidationResult } from "../auth/types.js";
import type { ProviderAccount } from "../db/index.js";
import type { UpstreamResponse } from "../providers/types.js";
import { buildAccountErrorMessage, codexUsageLimitDisabledUntil, endpointPath, isAntigravityResourceExhausted, prefixWithProvider, readBodyLimit, sanitizedProxyError, shouldRotate } from "./errors.js";
import { stripImageContent, stripToolCallParameters } from "./content.js";
import type { AccountRotationFailure, EndpointAdapter, ParsedEndpointRequest, RouteError } from "./types.js";
import type { PointReservation } from "./points.js";

export interface RotationRunner {
  getNextAvailableAccount(userID: string, model: string, provider: string | null, exclude: string[], excludeProviders: string[], accountAccess: { mode: string; accounts: string[] }, sessionID: string): Promise<[ProviderAccount | null, boolean, Error | null]>;
  getNextSharedAccount(userID: string, model: string, provider: string | null, exclude: string[], excludeProviders: string[]): Promise<[ProviderAccount | null, boolean, Error | null]>;
  reserveRoamingPoint(userID: string): Promise<[PointReservation | null, boolean, Error | null]>;
  refundRoamingPoint(reservation: PointReservation | null): Promise<void>;
  bumpAccountRequestCount(accountID: string, usedAt: Date): Promise<void>;
  makeProviderRequest(account: ProviderAccount, payload: Record<string, unknown>, stream: boolean, ctx: Record<string, unknown>): Promise<UpstreamResponse>;
  markAccountFailed(accountID: string, model: string, status: number, message: string): Promise<Date>;
  markAccountUsageLimited(accountID: string, model: string, disabledUntil: Date, failedAt: Date): Promise<void>;
  logUsage(params: { userId: string; providerAccountId: string; proxyApiKeyId: string; model: string; statusCode: number; durationMS: number; provider: string }): Promise<void>;
  isVisionModel(model: string): boolean;
  isToolCallModel(model: string): boolean;
}

export interface RotationResult {
  account: ProviderAccount | null;
  response: UpstreamResponse | null;
  requestStartMS: number;
  upstreamFirstResponseMS: number;
  rotationFailures: AccountRotationFailure[];
  roaming: PointReservation | null;
  error: RouteError | null;
}

export async function executeAccountRotation(
  runner: RotationRunner,
  cfg: EndpointAdapter,
  parsed: ParsedEndpointRequest,
  authResult: AuthResult,
  validation: ModelValidationResult,
  forced: ProviderAccount | null,
  startMS: number,
  sessionID: string,
): Promise<RotationResult> {
  const tried: string[] = [];
  const sharedTried: string[] = [];
  const excludedProviders: string[] = [];
  let useShared = false;
  const recoverableFailures: AccountRotationFailure[] = [];
  let lastFailure: RouteError | null = null;
  let delayedFinalFailure: { account: ProviderAccount; statusCode: number; message: string } | null = null;
  let accountConfigured = false;

  for (;;) {
    let attempt: { account: ProviderAccount | null; roaming: PointReservation | null } = { account: forced, roaming: null };
    if (attempt.account === null) {
      let selected: ProviderAccount | null = null;
      let configured = false;
      let err: Error | null = null;
      if (useShared) {
        [selected, configured, err] = await runner.getNextSharedAccount(authResult.userId, validation.model, validation.provider, sharedTried, excludedProviders);
      } else {
        [selected, configured, err] = await runner.getNextAvailableAccount(authResult.userId, validation.model, validation.provider, tried, excludedProviders, { mode: authResult.accountAccessMode, accounts: authResult.accountAccessList }, sessionID);
      }
      if (err) {
        return { account: null, response: null, requestStartMS: 0, upstreamFirstResponseMS: 0, rotationFailures: recoverableFailures, roaming: null, error: { status: 500, message: "Internal server error", type: "api_error", param: null, code: null, retryAfter: null, retryAfterMS: null, accountID: "" } };
      }
      accountConfigured = accountConfigured || configured;
      attempt.account = selected;
    }

    if (attempt.account === null && !useShared && forced === null && authResult.roamingEnabled) {
      useShared = true;
      continue;
    }

    if (attempt.account === null) {
      if (lastFailure && delayedFinalFailure) {
        await runner.markAccountFailed(delayedFinalFailure.account.id, validation.model, delayedFinalFailure.statusCode, delayedFinalFailure.message);
      }
      if (tried.length + sharedTried.length === 0) {
        if (accountConfigured) {
          return { account: null, response: null, requestStartMS: 0, upstreamFirstResponseMS: 0, rotationFailures: recoverableFailures, roaming: null, error: { status: 503, message: "This model is temporarily unavailable. Please try again later.", type: "api_error", param: null, code: null, retryAfter: null, retryAfterMS: null, accountID: "" } };
        }
        return { account: null, response: null, requestStartMS: 0, upstreamFirstResponseMS: 0, rotationFailures: recoverableFailures, roaming: null, error: { status: cfg.noAccountsStatusCode, message: "No active accounts available for this model. Please add an account in the dashboard.", type: "configuration_error", param: null, code: null, retryAfter: null, retryAfterMS: null, accountID: "" } };
      }
      if (lastFailure) {
        return { account: null, response: null, requestStartMS: 0, upstreamFirstResponseMS: 0, rotationFailures: recoverableFailures, roaming: null, error: lastFailure };
      }
      return { account: null, response: null, requestStartMS: 0, upstreamFirstResponseMS: 0, rotationFailures: recoverableFailures, roaming: null, error: { status: 503, message: "No available accounts for this request.", type: "api_error", param: null, code: null, retryAfter: null, retryAfterMS: null, accountID: "" } };
    }
    if (useShared && forced === null) {
      const [points, allowed, err] = await runner.reserveRoamingPoint(authResult.userId);
      if (err) {
        return { account: null, response: null, requestStartMS: 0, upstreamFirstResponseMS: 0, rotationFailures: recoverableFailures, roaming: null, error: { status: 500, message: "Internal server error", type: "api_error", param: null, code: null, retryAfter: null, retryAfterMS: null, accountID: "" } };
      }
      if (!allowed) {
        return { account: null, response: null, requestStartMS: 0, upstreamFirstResponseMS: 0, rotationFailures: recoverableFailures, roaming: null, error: { status: 402, message: "Insufficient points. Please add more points to continue.", type: "insufficient_quota", param: null, code: "insufficient_points", retryAfter: null, retryAfterMS: null, accountID: "" } };
      }
      attempt.roaming = points;
    }

    if (useShared) {
      sharedTried.push(attempt.account.id);
    } else {
      tried.push(attempt.account.id);
    }
    if (forced !== null) {
      void runner.bumpAccountRequestCount(attempt.account.id, new Date());
    }
    const payload = cfg.build(parsed, validation.model, parsed.stream, sessionID);
    if (!runner.isVisionModel(validation.model)) {
      stripImageContent(payload);
    }
    if (!runner.isToolCallModel(validation.model)) {
      stripToolCallParameters(payload);
    }
    const requestStart = Date.now();
    let upstreamFirstResponseMS = 0;
    const attemptCtx: Record<string, unknown> = {
      recordResponseStart: (at: Date) => {
        if (upstreamFirstResponseMS === 0) upstreamFirstResponseMS = at.getTime();
      },
    };
    let resp: UpstreamResponse;
    try {
      resp = await runner.makeProviderRequest(attempt.account, payload, parsed.stream, attemptCtx);
    } catch (error) {
      const err = error as Error;
      delayedFinalFailure = null;
      const status = 500;
      const message = err.message;
      const detailed = buildAccountErrorMessage(message, { model: validation.model, provider: attempt.account.provider, endpoint: endpointPath(cfg.endpoint), messages: parsed.messagesForError, parameters: parsed.paramsForError });
      const failedAt = await runner.markAccountFailed(attempt.account.id, validation.model, status, detailed);
      await runner.logUsage({ userId: authResult.userId, providerAccountId: attempt.account.id, proxyApiKeyId: authResult.apiKeyId, model: validation.model, statusCode: status, durationMS: Date.now() - startMS, provider: attempt.account.provider });
      lastFailure = { status, message: prefixWithProvider(attempt.account.provider, message), type: "api_error", param: null, code: null, retryAfter: null, retryAfterMS: null, accountID: attempt.account.id };
      if (attempt.roaming) {
        await runner.refundRoamingPoint(attempt.roaming);
      }
      if (forced === null) {
        recoverableFailures.push({ accountId: attempt.account.id, failedAt });
        continue;
      }
      return { account: null, response: null, requestStartMS: 0, upstreamFirstResponseMS: 0, rotationFailures: recoverableFailures, roaming: null, error: lastFailure };
    }
    if (upstreamFirstResponseMS === 0 && resp) {
      upstreamFirstResponseMS = Date.now();
    }

    if (resp.status < 200 || resp.status >= 300) {
      const bodyText = await readBodyLimit(resp.body, 1 << 20);
      let failedAt: Date | null = null;
      delayedFinalFailure = null;
      const badRequestFromProvider = resp.status === 400;
      const fallbackAcrossProviders = badRequestFromProvider && forced === null && validation.provider === null;
      if (resp.status !== 408 && !badRequestFromProvider) {
        const detailed = buildAccountErrorMessage(bodyText, { model: validation.model, provider: attempt.account.provider, endpoint: endpointPath(cfg.endpoint), messages: parsed.messagesForError, parameters: parsed.paramsForError });
        if (forced === null && isAntigravityResourceExhausted(attempt.account.provider, resp.status, bodyText)) {
          delayedFinalFailure = { account: attempt.account, statusCode: resp.status, message: detailed };
        } else {
          failedAt = await runner.markAccountFailed(attempt.account.id, validation.model, resp.status, detailed);
          const [disabledUntil, ok] = codexUsageLimitDisabledUntil(attempt.account.provider, resp.status, bodyText, failedAt);
          if (ok) {
            await runner.markAccountUsageLimited(attempt.account.id, validation.model, disabledUntil, failedAt);
          }
        }
      }
      await runner.logUsage({ userId: authResult.userId, providerAccountId: attempt.account.id, proxyApiKeyId: authResult.apiKeyId, model: validation.model, statusCode: resp.status, durationMS: Date.now() - startMS, provider: attempt.account.provider });
      const [message, typ] = sanitizedProxyError(resp.status, bodyText);
      lastFailure = { status: resp.status, message: prefixWithProvider(attempt.account.provider, message), type: typ, param: null, code: null, retryAfter: null, retryAfterMS: null, accountID: attempt.account.id };
      if (attempt.roaming) {
        await runner.refundRoamingPoint(attempt.roaming);
      }
      if (fallbackAcrossProviders) {
        excludedProviders.push(attempt.account.provider);
        continue;
      }
      if (shouldRotate(resp.status) && forced === null) {
        if (failedAt) {
          recoverableFailures.push({ accountId: attempt.account.id, failedAt });
        }
        continue;
      }
      return { account: null, response: null, requestStartMS: 0, upstreamFirstResponseMS: 0, rotationFailures: recoverableFailures, roaming: null, error: lastFailure };
    }

    return { account: attempt.account, response: resp, requestStartMS: requestStart, upstreamFirstResponseMS, rotationFailures: recoverableFailures, roaming: attempt.roaming, error: null };
  }
}

export function sessionID(request: Request): string {
  const value = request.headers.get("session_id");
  if (value) return value;
  return request.headers.get("x-session-id") ?? "";
}
