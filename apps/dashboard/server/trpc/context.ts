import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";

import { getSessionFromEvent } from "../utils/session";

type EventWithHeaders = {
  headers: Headers;
};

export async function createContext(
  event: EventWithHeaders,
  _opts?: FetchCreateContextFnOptions
) {
  void _opts;
  const session = await getSessionFromEvent(event as Parameters<typeof getSessionFromEvent>[0]);

  return {
    event,
    session,
    userId: session?.user?.id ?? null,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
