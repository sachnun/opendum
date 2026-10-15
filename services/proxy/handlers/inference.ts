import { Effect, Schema } from "effect";
import { type H3Event } from "h3";
import type { ProxyContext } from "../core/context.js";
import { extractSessionId } from "../core/service.js";
import type { EndpointAdapter } from "../core/endpoints.js";
import { jsonResponse } from "./errors.js";

const BodySchema = Schema.Record(Schema.String, Schema.Unknown);

const parseBody = Schema.decodeUnknownEffect(BodySchema);

class InvalidBody extends Schema.TaggedError<InvalidBody>()("InvalidBody", {
  message: Schema.String,
}) {}

const invalidBodyResponse = (): Response =>
  jsonResponse(
    {
      error: {
        message: "Invalid JSON in request body",
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    },
    400
  );

export async function handleInference(
  event: H3Event,
  context: ProxyContext,
  endpoint: EndpointAdapter
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
    const sessionId = extractSessionId(event.req, body);
    return yield* Effect.promise(() => context.service.handle(endpoint, body, authHeader, sessionId, event.req));
  });

  return Effect.runPromise(
    program.pipe(
      Effect.catchTag("InvalidBody", () => Effect.succeed(invalidBodyResponse())),
      Effect.withSpan("handleInference", { attributes: { endpoint: endpoint.endpoint } })
    )
  );
}
