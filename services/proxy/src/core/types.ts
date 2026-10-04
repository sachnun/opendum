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

export type EndpointAdapter = {
  endpoint: string;
  format: ErrorFormat;
  rateLimitStatusCode: number;
  noAccountsStatusCode: number;
  parse: (body: Record<string, unknown>) => ParsedEndpointRequest | RouteError;
  build: (
    parsed: ParsedEndpointRequest,
    model: string,
    stream: boolean,
    sessionId: string
  ) => Record<string, unknown>;
  handleStream: (ctx: ResponseContext, recorder: StreamRecorder) => Promise<Response>;
  handleNonStream: (ctx: ResponseContext, recorder: StreamRecorder) => Promise<Response>;
};

export type AccountRotationFailure = {
  accountId: string;
  failedAt: Date;
};

export function isRouteError(value: ParsedEndpointRequest | RouteError): value is RouteError {
  return "status" in value && typeof (value as RouteError).status === "number";
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

export type StreamRecorder = {
  recordSuccessfulRequest(params: {
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
  }): void;
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
