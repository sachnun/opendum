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
