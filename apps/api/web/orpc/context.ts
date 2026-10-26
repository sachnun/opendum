import { ORPCError } from "@orpc/server";
import { Effect } from "effect";
import { HTTPError } from "h3";

import { contextOf, type RequestContext } from "@opendum/api/web/utils/api";
import { asFailure } from "@opendum/api/web/errors";

export interface OrpcInitialContext {
  headers: Headers;
  url: string;
}

export interface OrpcContext extends OrpcInitialContext {
  requestContext: RequestContext;
}

function orpcError(error: unknown) {
  if (error instanceof HTTPError) {
    if (error.status === 401) return new ORPCError("UNAUTHORIZED", { message: "Unauthorized" });
    if (error.status === 403) return new ORPCError("FORBIDDEN", { message: error.statusText || "Forbidden" });
  }
  const failure = asFailure(error);
  return new ORPCError("INTERNAL_SERVER_ERROR", { message: failure.message });
}

export function resolveContext(headers: Headers) {
  return contextOf(headers).pipe(Effect.mapError(orpcError));
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
