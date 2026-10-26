import { Effect } from "effect";

import type { OAuthResult } from "@opendum/providers/auth/result";
import { httpError } from "@opendum/providers/auth/http-errors";
import { AuthFailure, asFailure } from "@opendum/providers/auth/failure";

export class ProviderResponse {
  private readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  text(response: Response): Effect.Effect<string, AuthFailure> {
    return Effect.tryPromise({
      try: () => response.text().catch(() => ""),
      catch: (cause) => asFailure(cause, `Failed to read ${this.label} response`),
    });
  }

  json<T>(response: Response): Effect.Effect<T, AuthFailure> {
    return Effect.tryPromise({
      try: async () => (await response.json()) as T,
      catch: (cause) => asFailure(cause, `Failed to read ${this.label} response`),
    });
  }

  jsonOr<T>(response: Response, fallback: T): Effect.Effect<T, AuthFailure> {
    return Effect.tryPromise({
      try: async () => (await response.json().catch(() => fallback)) as T,
      catch: (cause) => asFailure(cause, `Failed to read ${this.label} response`),
    });
  }

  failure(response: Response, body: string, endpointLabel: string): string {
    return httpError(this.label, response, body, { endpointLabel });
  }
}

export type PollPending = { pending: true; retryAfterSeconds?: number };
export type PollFailure = { error: string };
export type PollResult = PollPending | PollFailure;

export function pendingResult(retryAfterSeconds?: number): PollPending {
  return retryAfterSeconds === undefined
    ? { pending: true }
    : { pending: true, retryAfterSeconds };
}

export function failedResult(message: string): PollFailure {
  return { error: message };
}

export function isPending(value: unknown): value is PollPending {
  return Boolean(value && typeof value === "object" && "pending" in value);
}

export function isFailed(value: unknown): value is PollFailure {
  return Boolean(value && typeof value === "object" && "error" in value);
}

export interface DeviceCodeInitiate {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceCodeFlow {
  startDeviceFlow(): Effect.Effect<DeviceCodeInitiate, AuthFailure>;
  pollDeviceAuth(
    deviceCode: string,
    userCode: string
  ): Effect.Effect<PollResult | OAuthResult, AuthFailure>;
}
