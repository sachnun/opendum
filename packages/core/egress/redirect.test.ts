import { describe, expect, it } from "bun:test";
import type { GuardedFetch } from "./guard.js";
import { DEFAULT_MAX_REDIRECTS, GuardedFetcher, RedirectPolicy } from "./redirect.js";
import { PrivateHostError } from "./ssrf.js";

type StubCall = {
  url: string;
  init: RequestInit | undefined;
};

type Stub = {
  fetch: GuardedFetch;
  calls: StubCall[];
};

function stubFetch(handler: (url: string) => Response): Stub {
  const calls: StubCall[] = [];
  const fetchFn: GuardedFetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(handler(url));
  };
  return { fetch: fetchFn, calls };
}

function redirectResponse(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("RedirectPolicy", () => {
  it("returns non-redirect responses with a forced manual redirect", async () => {
    const stub = stubFetch(() => new Response("ok", { status: 200 }));
    const response = await new RedirectPolicy().follow(stub.fetch, "https://example.com/start", {
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
      url === "https://example.com/start" ? redirectResponse(302, "/next") : new Response("done", { status: 200 })
    );
    const response = await new RedirectPolicy().follow(stub.fetch, "https://example.com/start");
    expect(await response.text()).toBe("done");
    expect(stub.calls.map((call) => call.url)).toEqual(["https://example.com/start", "https://example.com/next"]);
  });

  it("rewrites the method to GET on 303", async () => {
    const stub = stubFetch((url) =>
      url === "https://example.com/form" ? redirectResponse(303, "https://example.com/done") : new Response("done", { status: 200 })
    );
    await new RedirectPolicy().follow(stub.fetch, "https://example.com/form", { method: "POST", body: "payload" });
    expect(stub.calls[1].init?.method).toBe("GET");
    expect(stub.calls[1].init?.body).toBeUndefined();
    expect(stub.calls[1].init?.redirect).toBe("manual");
  });

  it("rewrites a POST to GET on 301", async () => {
    const stub = stubFetch((url) =>
      url === "https://example.com/form" ? redirectResponse(301, "https://example.com/done") : new Response("done", { status: 200 })
    );
    await new RedirectPolicy().follow(stub.fetch, "https://example.com/form", { method: "POST", body: "payload" });
    expect(stub.calls[1].init?.method).toBe("GET");
  });

  it("rejects redirects that leave https", async () => {
    const stub = stubFetch(() => redirectResponse(302, "http://example.com/insecure"));
    const error = await failureOf(() => new RedirectPolicy().follow(stub.fetch, "https://example.com/start"));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("redirect must use https");
  });

  it("stops after the default maximum redirects", async () => {
    const stub = stubFetch(() => redirectResponse(302, "https://example.com/loop"));
    const error = await failureOf(() => new RedirectPolicy().follow(stub.fetch, "https://example.com/loop"));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("stopped after 10 redirects");
    expect(stub.calls).toHaveLength(DEFAULT_MAX_REDIRECTS + 1);
  });

  it("rejects private hosts before any fetch", async () => {
    const stub = stubFetch(() => new Response("unreachable", { status: 200 }));
    const error = await failureOf(() => new RedirectPolicy().follow(stub.fetch, "http://10.0.0.1/"));
    expect(error).toBeInstanceOf(PrivateHostError);
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects private hosts on later hops", async () => {
    const stub = stubFetch((url) =>
      url === "https://example.com/start"
        ? redirectResponse(302, "https://10.0.0.1/")
        : new Response("unreachable", { status: 200 })
    );
    const error = await failureOf(() => new RedirectPolicy().follow(stub.fetch, "https://example.com/start"));
    expect(error).toBeInstanceOf(PrivateHostError);
    expect(stub.calls).toHaveLength(1);
  });
});

describe("GuardedFetcher", () => {
  it("exposes a redirect policy and closes", async () => {
    const fetcher = new GuardedFetcher();
    expect(fetcher.policy).toBeInstanceOf(RedirectPolicy);
    expect(fetcher.policy.maxRedirects).toBe(DEFAULT_MAX_REDIRECTS);
    await fetcher.close();
  });

  it("accepts a custom redirect policy", async () => {
    const policy = new RedirectPolicy(3);
    const fetcher = new GuardedFetcher({ policy });
    expect(fetcher.policy).toBe(policy);
    await fetcher.close();
  });
});
