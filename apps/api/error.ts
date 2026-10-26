import { defineErrorHandler, HTTPError } from "nitro";
import { errorEnvelope, formatPath, inferencePath } from "@opendum/api/handlers/errors";

export default defineErrorHandler((error, event) => {
  const pathname = new URL(event.req.url).pathname;
  if (!inferencePath(pathname)) return;

  const format = formatPath(pathname);
  if (HTTPError.isError(error) && !error.unhandled) {
    const status = error.status ?? 500;
    const message = error.message || error.statusText || "Request failed";
    const type = status >= 500 ? "api_error" : "invalid_request_error";
    return new Response(JSON.stringify(errorEnvelope(format, message, type)), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.error("[api] unhandled inference error", error);
  return new Response(JSON.stringify(errorEnvelope(format, "Internal server error", "api_error")), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
});
