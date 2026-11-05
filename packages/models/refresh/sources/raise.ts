import { Effect } from "effect";

export function raise(error: Error): never {
  return Effect.runSync(Effect.die(error));
}
