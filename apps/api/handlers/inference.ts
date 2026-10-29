import { Effect, Schema } from "effect";
import type { H3Event } from "h3";
import type { ProxyContext } from "@opendum/api/proxy/context";
import { sessionKey } from "@opendum/api/proxy/service";
import type { Adapter } from "@opendum/api/proxy/endpoints";
import { errorEnvelope, internalResponse, jsonResponse } from "@opendum/api/handlers/errors";

const BodySchema = Schema.Record(Schema.String, Schema.Unknown);

const parseBody = Schema.decodeUnknownEffect(BodySchema);

class InvalidBody extends Schema.TaggedError<InvalidBody>()("InvalidBody", {
  message: Schema.String,
}) {}

const invalidBodyResponse = (format: Adapter["format"]): Response =>
  jsonResponse(errorEnvelope(format, "Invalid JSON in request body", "invalid_request_error"), 400);

export async function handleInference(
  event: H3Event,
  context: ProxyContext,
  endpoint: Adapter
): Promise<Response> {
  const program = Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => event.req.json() as Promise<unknown>,
      catch: () => new InvalidBody({ message: "Invalid JSON in request body" }),
    });
    const body = yield* parseBody(raw).pipe(
      Effect.catch(() => Effect.fail(new InvalidBody({ message: "Invalid JSON in request body" })))
    );
    const authHeader = event.req.headers.get("authorization") ?? event.req.headers.get("x-api-key") ?? "";
    const sessionId = sessionKey(event.req, body);
    return yield* Effect.promise(() => context.service.handle(endpoint, body, authHeader, sessionId, event.req));
  });

  return Effect.runPromise(
    program.pipe(
      Effect.catchTag("InvalidBody", () => Effect.succeed(invalidBodyResponse(endpoint.format))),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          void Effect.runFork(
            Effect.logError("inference request failed").pipe(
              Effect.annotateLogs({
                endpoint: endpoint.endpoint,
                cause: String(cause),
              })
            )
          );
          return internalResponse(endpoint.format);
        })
      ),
      Effect.withSpan("handleInference", { attributes: { endpoint: endpoint.endpoint } })
    )
  );
}
