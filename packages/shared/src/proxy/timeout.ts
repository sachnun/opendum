/**
 * Optional callback invoked when response headers arrive (TTFB measured).
 * The callback receives the elapsed milliseconds from request start to
 * first byte.  It is called for **all** responses (including errors) so
 * the caller can decide whether to record the sample.
 */
export type OnTTFBCallback = (ttfbMs: number) => void;

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
 *
 * @param onTTFB  Optional callback fired once headers arrive with the measured
 *                TTFB in milliseconds.  Never called on timeout / abort.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
  onTTFB?: OnTTFBCallback,
): Promise<Response> {
  const controller = new AbortController();
  const requestStart = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    // Headers received — clear the timeout regardless of stream/non-stream.
    clearTimeout(timer);

    // Notify the caller of the measured TTFB.
    if (onTTFB) {
      try {
        onTTFB(Date.now() - requestStart);
      } catch {
        // Callback errors must never affect the response path.
      }
    }

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
