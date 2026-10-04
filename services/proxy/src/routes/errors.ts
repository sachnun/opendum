export type ErrorInfo = {
  message: string;
  type: string;
  param?: string | null;
  code?: string | null;
  retryAfter?: string | null;
  retryAfterMs?: number | null;
};

export function openAIError(info: ErrorInfo): Response {
  const body = {
    error: {
      message: info.message,
      type: info.type,
      param: info.param ?? null,
      code: info.code ?? null,
      ...(info.retryAfter ? { retry_after: info.retryAfter } : {}),
      ...(info.retryAfterMs ? { retry_after_ms: info.retryAfterMs } : {}),
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function jsonResponse(value: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (extraHeaders) {
    for (const [key, val] of Object.entries(extraHeaders)) headers.set(key, val);
  }
  return new Response(JSON.stringify(value), { status, headers });
}

export function unknownEndpoint(): Response {
  return jsonResponse(
    {
      error: {
        message: "Unknown API endpoint.",
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    },
    404
  );
}

export function notFound(): Response {
  return jsonResponse(
    {
      error: {
        message: "Not Found",
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    },
    404
  );
}
