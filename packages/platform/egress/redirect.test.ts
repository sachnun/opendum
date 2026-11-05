import { describe, expect, it } from "bun:test";
import { Effect, Exit } from "effect";
import type { Fetch } from "@opendum/platform/egress/guard";
import { MAX_REDIRECTS, Fetcher, Redirects } from "@opendum/platform/egress/redirect";

type StubCall = {
  url: string;
  init: RequestInit | undefined;
};

type Stub = {
  fetch: Fetch;
  calls: StubCall[];
};

function stubFetch(handler: (url: string) => Response): Stub {
  const calls: StubCall[] = [];
  const fetchFn: Fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url);
  };
  return { fetch: fetchFn, calls };
}

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

function follow(stub: Stub, url: string, init?: RequestInit): Promise<Response> {
  return Effect.runPromise(new Redirects().follow(stub.fetch, url, init));
}

async function failureOf(stub: Stub, url: string): Promise<unknown> {
  const exit = await Effect.runPromiseExit(new Redirects().follow(stub.fetch, url));
  return Exit.isFailure(exit) ? exit.cause : undefined;
}

describe("Redirects", () => {
  it("returns non-redirect responses with a forced manual redirect", async () => {
    const stub = stubFetch(() => new Response("ok", { status: 200 }));
    const response = await follow(stub, "https://example.com/start", {
      method: "POST",
      redirect: "follow",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url).toBe("https://example.com/start");
    expect(stub.calls[0].init?.method).toBe("POST");
    expect(stub.calls[0].init?.redirect).toBe("manual");
  });

  it("follows a relative location", async () => {
    const stub = stubFetch((url) =>
      url === "https://example.com/start" ? redirect(302, "/next") : new Response("done", { status: 200 })
    );
    const response = await follow(stub, "https://example.com/start");
    expect(await response.text()).toBe("done");
    expect(stub.calls.map((call) => call.url)).toEqual(["https://example.com/start", "https://example.com/next"]);
  });

  it("rewrites the method to GET on 303", async () => {
    const stub = stubFetch((url) =>
      url === "https://example.com/form" ? redirect(303, "https://example.com/done") : new Response("done", { status: 200 })
    );
    await follow(stub, "https://example.com/form", { method: "POST", body: "payload" });
    expect(stub.calls[1].init?.method).toBe("GET");
    expect(stub.calls[1].init?.body).toBeUndefined();
    expect(stub.calls[1].init?.redirect).toBe("manual");
  });

  it("rewrites a POST to GET on 301", async () => {
    const stub = stubFetch((url) =>
      url === "https://example.com/form" ? redirect(301, "https://example.com/done") : new Response("done", { status: 200 })
    );
    await follow(stub, "https://example.com/form", { method: "POST", body: "payload" });
    expect(stub.calls[1].init?.method).toBe("GET");
  });

  it("rejects redirects that leave https", async () => {
    const stub = stubFetch(() => redirect(302, "http://example.com/insecure"));
    const error = await failureOf(stub, "https://example.com/start");
    expect(error).toBeDefined();
    expect(stub.calls).toHaveLength(1);
  });

  it("stops after the default maximum redirects", async () => {
    const stub = stubFetch(() => redirect(302, "https://example.com/loop"));
    const error = await failureOf(stub, "https://example.com/loop");
    expect(error).toBeDefined();
    expect(stub.calls).toHaveLength(MAX_REDIRECTS + 1);
  });

  it("rejects private hosts before any fetch", async () => {
    const stub = stubFetch(() => new Response("unreachable", { status: 200 }));
    const error = await failureOf(stub, "http://10.0.0.1/");
    expect(error).toBeDefined();
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects private hosts on later hops", async () => {
    const stub = stubFetch((url) =>
      url === "https://example.com/start"
        ? redirect(302, "https://10.0.0.1/")
        : new Response("unreachable", { status: 200 })
    );
    const error = await failureOf(stub, "https://example.com/start");
    expect(error).toBeDefined();
    expect(stub.calls).toHaveLength(1);
  });
});

describe("Fetcher", () => {
  it("exposes a redirect policy and closes", async () => {
    const fetcher = new Fetcher();
    expect(fetcher.policy).toBeInstanceOf(Redirects);
    expect(fetcher.policy.maxRedirects).toBe(MAX_REDIRECTS);
    await Effect.runPromise(fetcher.close());
  });

  it("accepts a custom redirect policy", async () => {
    const policy = new Redirects(3);
    const fetcher = new Fetcher({ policy });
    expect(fetcher.policy).toBe(policy);
    await Effect.runPromise(fetcher.close());
  });
});
