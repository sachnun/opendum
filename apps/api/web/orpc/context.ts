import { ORPCError } from "@orpc/server";
import { Effect } from "effect";
import { HTTPError } from "h3";

import { contextOf, type RequestContext } from "@opendum/api/web/utils/api";
import { asFailure } from "@opendum/api/web/errors";
import { orpcError as serviceError } from "@opendum/api/web/orpc/run";

export interface OrpcInitialContext {
  headers: Headers;
  url: string;
}

export interface OrpcContext extends OrpcInitialContext {
  requestContext: RequestContext;
}

function contextError(error: unknown) {
  if (error instanceof HTTPError) {
    if (error.status === 401) return new ORPCError("UNAUTHORIZED", { message: "Unauthorized" });
    if (error.status === 403) return new ORPCError("FORBIDDEN", { message: error.statusText || "Forbidden" });
  }
  return serviceError(asFailure(error));
}

export function resolveContext(headers: Headers) {
  return contextOf(headers).pipe(Effect.mapError(contextError));
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
