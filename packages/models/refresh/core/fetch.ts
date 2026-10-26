import { Effect } from "effect";
import { raise } from "@opendum/models/refresh/core/raise";

const UNPKG = "https://unpkg.com";

const getJson = (url: string): Effect.Effect<unknown, Error> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) raise(new Error(`failed to fetch ${url} (${response.status})`));
      return (await response.json()) as unknown;
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

export const packageVersion = (name: string): Effect.Effect<string, Error> =>
  getJson(`${UNPKG}/${name}/package.json`).pipe(
    Effect.flatMap((manifest) => {
      const version =
        manifest !== null && typeof manifest === "object"
          ? (manifest as Record<string, unknown>).version
          : undefined;
      return typeof version === "string" && version.trim()
        ? Effect.succeed(version.trim())
        : Effect.fail(new Error(`could not read the version of ${name} from unpkg`));
    })
  );

export const packageFile = (
  name: string,
  file: string,
  version: string
): Effect.Effect<unknown, Error> =>
  getJson(`${UNPKG}/${name}@${version}/${file.replace(/^\/+/, "")}`);
