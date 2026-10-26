import { Result } from "effect";
import { Safe } from "@opendum/api/core/helpers";
import { HEADERS_TIMEOUT_MESSAGE } from "@opendum/api/core/upstream-timeout";

export class ProviderError {
  static sanitize(status: number, body: string): { message: string; type: string } {
    const type = ProviderError.typeOf(status);
    let message = ProviderError.detail(body);
    if (!message) {
      message = ProviderError.statusText(status);
      if (!message) message = "Provider request failed";
    }
    return { message, type };
  }

  static typeOf(status: number): string {
    switch (status) {
      case 401:
      case 403:
        return "authentication_error";
      case 408:
        return "timeout_error";
      case 429:
        return "rate_limit_error";
      default:
        break;
    }
    if (status >= 500) return "api_error";
    if (status >= 400) return "invalid_request_error";
    return "api_error";
  }

  static detail(body: string): string {
    const trimmed = body.trim();
    if (!trimmed) return "";
    const parsed = Safe.json(trimmed);
    if (Result.isSuccess(parsed)) {
      const message = ProviderError.findMessage(parsed.success, 0);
      if (message) return ProviderError.normalizeClientError(message);
    }
    return ProviderError.normalizeClientError(trimmed);
  }

  static shouldRotate(status: number): boolean {
    return status >= 500 || [429, 408, 404, 403, 402, 401].includes(status);
  }

  static transient(status: number): boolean {
    return status === 408 || status >= 500;
  }

  static timeout(message: string): boolean {
    return (
      message.includes(HEADERS_TIMEOUT_MESSAGE) || message.includes("upstream request timed out")
    );
  }

  static retryMetadata(durationMs: number): { retryAfter: string | null; afterMs: number | null } {
    if (durationMs <= 0) return { retryAfter: null, afterMs: null };
    const ms = Math.max(1, Math.trunc(durationMs));
    let seconds = Math.trunc(durationMs / 1000);
    if (durationMs % 1000 !== 0) seconds += 1;
    if (seconds < 1) seconds = 1;
    return { retryAfter: `${seconds}s`, afterMs: ms };
  }

  static path(endpoint: string): string {
    switch (endpoint) {
      case "chat_completions":
        return "/v1/chat/completions";
      case "messages":
        return "/v1/messages";
      case "responses":
        return "/v1/responses";
      default:
        return `/${endpoint.replace(/^\/+/, "")}`;
    }
  }

  static prefix(providerName: string, message: string): string {
    if (!message) return message;
    if (!providerName) return message;
    return `[${providerName}] ${message}`;
  }

  private static findMessage(value: unknown, depth: number): string {
    if (depth > 6 || value === null || value === undefined) return "";
    if (typeof value === "string") {
      const nested = Safe.json(value);
      if (Result.isSuccess(nested)) {
        const message = ProviderError.findMessage(nested.success, depth + 1);
        if (message) return message;
      }
      return value;
    }
    if (typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const key of ["message", "msg", "detail", "error_description", "error"]) {
        const message = ProviderError.findMessage(record[key], depth + 1);
        if (message) return message;
      }
      if (Array.isArray(record.errors) && record.errors.length > 0) {
        return ProviderError.findMessage(record.errors[0], depth + 1);
      }
    }
    return "";
  }

  private static normalizeClientError(value: string): string {
    const normalized = value.trim().replace(/\s+/g, " ");
    if (normalized.length > 320) return `${normalized.slice(0, 320)}...[truncated]`;
    return normalized;
  }

  private static statusText(status: number): string {
    return Safe.sync(() => new Response(null, { status }).statusText || "", "");
  }
}

