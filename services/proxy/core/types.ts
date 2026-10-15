import type { AuthResult, ModelValidationResult } from "@opendum/auth";
import type { ProviderAccount } from "@opendum/providers";

export type ErrorFormat = "openai" | "anthropic";

export type ParsedEndpointRequest = {
  modelParam: string;
  stream: boolean;
  forcedAccountId: string | null;
  reasoningRequested: boolean;
  messagesForError: unknown;
  paramsForError: Record<string, unknown>;
  routeData: Record<string, unknown>;
};

export type RouteError = {
  status: number;
  message: string;
  type: string;
  param?: string | null;
  code?: string | null;
  retryAfter?: string | null;
  retryAfterMs?: number | null;
  accountId?: string;
};

export type UsageCounts = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
};

export type StreamCompletion = "success" | "cancel" | "error";

export type ResponseContext = {
  response: Response;
  accountId: string;
  provider: string;
  requestStartMs: number;
  upstreamFirstResponseMs: number;
  startMs: number;
  userId: string;
  apiKeyId: string;
  model: string;
  usage: UsageCounts;
  request?: Request;
  tools?: unknown;
  streamHandled?: boolean;
  onStreamComplete?: (reason: StreamCompletion) => void;
};

export type AccountRotationFailure = {
  accountId: string;
  failedAt: Date;
};

export function isRouteError(value: unknown): value is RouteError {
  return (
    value !== null &&
    typeof value === "object" &&
    "status" in value &&
    typeof (value as RouteError).status === "number" &&
    "message" in value &&
    typeof (value as RouteError).message === "string"
  );
}

export type AttemptResult = {
  account: ProviderAccount;
  response: Response;
  requestStartMs: number;
  upstreamFirstResponseMs: number;
  rotationFailures: AccountRotationFailure[];
  roaming: PointReservation | null;
};

export type PointReservation = {
  userId: string;
  model: string;
  amount: number;
  debitId: string;
};

export type SuccessfulRequestRecord = {
  accountId: string;
  provider: string;
  model: string;
  userId: string;
  apiKeyId: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
  stream: boolean;
  requestStartMs: number;
  upstreamFirstResponseMs: number;
};

export type StreamRecorder = {
  recordSuccessfulRequest(params: SuccessfulRequestRecord): void;
  storeHypercreditsUsage(
    accountId: string,
    remaining: number | null,
    cost: number
  ): void;
};

export type AuthContext = {
  auth: AuthResult;
  validation: ModelValidationResult;
};
