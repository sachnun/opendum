import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { EgressPoster, type EgressFetch, type FetchLike, type UpstreamTransport } from "@opendum/providers/core/http";

type Harness = { transport: UpstreamTransport; egressCalls: () => number; directCalls: () => number };

function harnessOf(status: number, egressStatus?: (attempt: number) => number): Harness {
  let egressCalls = 0;
  let directCalls = 0;
  const egress: EgressFetch = async () => {
    egressCalls += 1;
    return new Response("{}", { status: egressStatus ? egressStatus(egressCalls) : status });
  };
  const direct: FetchLike = async () => {
    directCalls += 1;
    return new Response("{}", { status });
  };
  return { transport: { direct, egress, egressReady: () => true }, egressCalls: () => egressCalls, directCalls: () => directCalls };
}

function execute() {
  return (fetchFn: FetchLike, url: string) => Effect.promise(() => fetchFn(url));
}

describe("egress retry policy", () => {
  it("retries a 429 through the egress address", async () => {
    const harness = harnessOf(429, (attempt) => (attempt < 3 ? 429 : 200));
    const response = await Effect.runPromise(
      new EgressPoster({ transport: harness.transport, state: null, provider: "p", primary: "u", execute: execute() }).send()
    );
    expect(response.status).toBe(200);
    expect(harness.egressCalls()).toBe(3);
    expect(harness.directCalls()).toBe(1);
  });

  it("honours a per provider limited retry budget", async () => {
    const harness = harnessOf(429);
    const response = await Effect.runPromise(
      new EgressPoster({
        transport: harness.transport,
        state: null,
        provider: "p",
        primary: "u",
        execute: execute(),
        retry: { limited: 5 },
      }).send()
    );
    expect(response.status).toBe(429);
    expect(harness.egressCalls()).toBe(5);
  });

  it("stops at one egress attempt when the forbidden budget is one", async () => {
    const harness = harnessOf(403);
    const response = await Effect.runPromise(
      new EgressPoster({
        transport: harness.transport,
        state: null,
        provider: "p",
        primary: "u",
        execute: execute(),
        retry: { forbidden: 1 },
      }).send()
    );
    expect(response.status).toBe(403);
    expect(harness.egressCalls()).toBe(1);
  });
});
