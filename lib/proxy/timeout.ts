/**
 * Fetch wrapper with timeout support using AbortController.
 *
 * The timeout covers the time from request initiation to when response headers
 * arrive (time-to-first-byte). For streaming requests this is usually fast
 * (the server sends headers as soon as it starts generating). For non-streaming
 * requests this effectively covers the entire model processing time since the
 * server buffers the full response before sending headers.
 *
 * On timeout the function returns a synthetic 408 Response so existing error
 * handling (shouldRotateToNextAccount, getApiErrorInfo) works unchanged.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    // Headers received — clear the timeout regardless of stream/non-stream.
    clearTimeout(timer);
    return response;
  } catch (error: unknown) {
    clearTimeout(timer);

    // AbortController.abort() causes a DOMException with name "AbortError"
    if (
      error instanceof DOMException &&
      error.name === "AbortError"
    ) {
      return new Response(
        JSON.stringify({
          error: {
            message: `Provider request timed out after ${timeoutMs}ms`,
            type: "timeout",
          },
        }),
        {
          status: 408,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    throw error;
  }
}
