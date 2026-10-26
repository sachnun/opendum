import type { ErrorFormat, RouteError } from "../types.js";
import {
  AuthenticationFailure,
  ConfigurationFailure,
  InsufficientPointsFailure,
  NoAccountsFailure,
  RateLimitFailure,
  UpstreamFailure,
  ValidationFailure,
  type ProxyFailure,
} from "./failures.js";

export class FailureMap {
  static toRoute(error: ProxyFailure): RouteError {
    switch (error._tag) {
      case "AuthenticationFailure":
        return {
          status: 401,
          message: error.message,
          type: "authentication_error",
          accountId: error.accountId,
        };
      case "ValidationFailure":
        return {
          status: error.status ?? 400,
          message: error.message,
          type: "invalid_request_error",
          param: error.param ?? null,
          code: error.code ?? null,
        };
      case "RateLimitFailure":
        return {
          status: error.status,
          message: error.message,
          type: "rate_limit_error",
          retryAfter: error.retryAfter ?? null,
          afterMs: error.afterMs ?? null,
          accountId: error.accountId,
        };
      case "NoAccountsFailure":
        return {
          status: error.status,
          message: error.message,
          type: error.type ?? "api_error",
        };
      case "InsufficientPointsFailure":
        return {
          status: 402,
          message: error.message,
          type: "insufficient_quota",
          code: error.code ?? "insufficient_points",
        };
      case "UpstreamFailure":
        return {
          status: error.status,
          message: error.message,
          type: error.type ?? "api_error",
          accountId: error.accountId,
        };
      case "ConfigurationFailure":
        return {
          status: error.status ?? 503,
          message: error.message,
          type: "configuration_error",
        };
      case "InternalFailure":
        return {
          status: error.status ?? 500,
          message: error.message,
          type: "api_error",
          accountId: error.accountId,
        };
    }
  }

  static fromRoute(error: RouteError): ProxyFailure {
    if (error.status === 401) {
      return new AuthenticationFailure({ message: error.message, accountId: error.accountId });
    }
    if (error.status === 402) {
      return new InsufficientPointsFailure({ message: error.message, code: error.code ?? null });
    }
    if (error.status === 429 || error.status === 529) {
      return new RateLimitFailure({
        message: error.message,
        status: error.status,
        retryAfter: error.retryAfter ?? null,
        afterMs: error.afterMs ?? null,
        accountId: error.accountId,
      });
    }
    if (error.type === "configuration_error") {
      return new ConfigurationFailure({ message: error.message, status: error.status });
    }
    if (error.status === 503) {
      return new NoAccountsFailure({ message: error.message, status: error.status, type: error.type });
    }
    if (error.status >= 500) {
      return new UpstreamFailure({
        message: error.message,
        status: error.status,
        type: error.type,
        accountId: error.accountId,
      });
    }
    return new ValidationFailure({
      message: error.message,
      param: error.param ?? null,
      code: error.code ?? null,
      status: error.status,
    });
  }

  static response(error: RouteError, format: ErrorFormat): Response {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (error.accountId) headers.set("X-Provider-Account-Id", error.accountId);
    if (error.afterMs != null && error.afterMs > 0) {
      headers.set("Retry-After", String(Math.max(1, Math.ceil(error.afterMs / 1000))));
    }
    if (format === "anthropic") {
      const body: Record<string, unknown> = {
        type: error.type || "invalid_request_error",
        message: error.message,
      };
      if (error.retryAfter != null) body.retry_after = error.retryAfter;
      if (error.afterMs != null) body.retry_after_ms = error.afterMs;
      return new Response(JSON.stringify({ type: "error", error: body }), {
        status: error.status,
        headers,
      });
    }
    const body = {
      error: {
        message: error.message,
        type: error.type || "invalid_request_error",
        param: error.param ?? null,
        code: error.code ?? null,
        ...(error.retryAfter != null ? { retry_after: error.retryAfter } : {}),
        ...(error.afterMs != null ? { retry_after_ms: error.afterMs } : {}),
      },
    };
    return new Response(JSON.stringify(body), { status: error.status, headers });
  }
}

