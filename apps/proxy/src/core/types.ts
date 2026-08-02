export interface RouteError {
  status: number;
  message: string;
  type: string;
  param: string | null;
  code: string | null;
  retryAfter: string | null;
  retryAfterMS: number | null;
  accountID: string;
}

export type ErrorFormatter = "openai" | "anthropic";

export interface ParsedEndpointRequest {
  modelParam: string;
  stream: boolean;
  forcedAccountID: string | null;
  reasoningRequested: boolean;
  messagesForError: unknown;
  paramsForError: Record<string, unknown>;
  routeData: Record<string, unknown>;
}

export interface AccountRotationFailure {
  accountId: string;
  failedAt: Date;
}

export interface EndpointAdapter {
  endpoint: string;
  format: ErrorFormatter;
  rateLimitStatusCode: number;
  noAccountsStatusCode: number;
  parse: (body: Record<string, unknown>) => [ParsedEndpointRequest, RouteError | null];
  build: (parsed: ParsedEndpointRequest, model: string, stream: boolean, sessionID: string) => Record<string, unknown>;
  handleStream: (ctx: ResponseContext) => Promise<void>;
  handleNonStream: (ctx: ResponseContext) => Promise<void>;
}

export interface ResponseContext {
  response: import("../providers/types.js").UpstreamResponse;
  accountId: string;
  provider: string;
  writer: StreamWriter;
  request: Request;
  requestStartMS: number;
  upstreamFirstResponseMS: number;
  startMS: number;
  userId: string;
  apiKeyId: string;
  model: string;
}

export interface StreamWriter {
  header(name: string, value: string): void;
  write(chunk: Uint8Array | string): Promise<void>;
  writeSSE?(event: { data?: string; event?: string; id?: string }): Promise<void>;
  flush?(): void;
}
