import { ORPCError } from "@orpc/server";
import { Effect } from "effect";
import { HTTPError } from "h3";

import { requireContextFromHeaders, type RequestContext } from "#web/utils/api.js";

export interface OrpcInitialContext {
  headers: Headers;
  url: string;
}

export interface OrpcContext extends OrpcInitialContext {
  requestContext: RequestContext;
}

function toOrpcError(error: unknown) {
  if (error instanceof HTTPError) {
    if (error.status === 401) return new ORPCError("UNAUTHORIZED", { message: "Unauthorized" });
    if (error.status === 403) return new ORPCError("FORBIDDEN", { message: error.statusText || "Forbidden" });
  }
  return new ORPCError("INTERNAL_SERVER_ERROR", { message: error instanceof Error ? error.message : "Request failed" });
}

export function resolveRequestContext(headers: Headers) {
  return Effect.tryPromise({ try: () => requireContextFromHeaders(headers), catch: toOrpcError });
}

export function requireWritable(requestContext: RequestContext) {
  return requestContext.isAuditMode
    ? Effect.fail(new ORPCError("FORBIDDEN", { message: "Audit mode is read-only" }))
    : Effect.succeed(requestContext);
}

export function requireMaintainer(requestContext: RequestContext) {
  return requestContext.isMaintainer
    ? Effect.succeed(requestContext)
    : Effect.fail(new ORPCError("FORBIDDEN", { message: "Maintainer access required" }));
}
