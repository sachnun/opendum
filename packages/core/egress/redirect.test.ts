import { describe, expect, it } from "bun:test";
import type { Fetch } from "./guard.js";
import { MAX_REDIRECTS, Fetcher, Redirects } from "./redirect.js";
import { PrivateHostError } from "./ssrf.js";

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
  const fetchFn: Fetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(handler(url));
  };
  return { fetch: fetchFn, calls };
}

function redirect(status: number, location: string): Response {
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

describe("Redirects", () => {
  it("returns non-redirect responses with a forced manual redirect", async () => {
    const stub = stubFetch(() => new Response("ok", { status: 200 }));
    const response = await new Redirects().follow(stub.fetch, "https://example.com/start", {
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
    const response = await new Redirects().follow(stub.fetch, "https://example.com/start");
    expect(await response.text()).toBe("done");
    expect(stub.calls.map((call) => call.url)).toEqual(["https://example.com/start", "https://example.com/next"]);
  });

  it("rewrites the method to GET on 303", async () => {
    const stub = stubFetch((url) =>
      url === "https://example.com/form" ? redirect(303, "https://example.com/done") : new Response("done", { status: 200 })
    );
    await new Redirects().follow(stub.fetch, "https://example.com/form", { method: "POST", body: "payload" });
    expect(stub.calls[1].init?.method).toBe("GET");
    expect(stub.calls[1].init?.body).toBeUndefined();
    expect(stub.calls[1].init?.redirect).toBe("manual");
  });

  it("rewrites a POST to GET on 301", async () => {
    const stub = stubFetch((url) =>
      url === "https://example.com/form" ? redirect(301, "https://example.com/done") : new Response("done", { status: 200 })
    );
    await new Redirects().follow(stub.fetch, "https://example.com/form", { method: "POST", body: "payload" });
    expect(stub.calls[1].init?.method).toBe("GET");
  });

  it("rejects redirects that leave https", async () => {
    const stub = stubFetch(() => redirect(302, "http://example.com/insecure"));
    const error = await failureOf(() => new Redirects().follow(stub.fetch, "https://example.com/start"));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("redirect must use https");
  });

  it("stops after the default maximum redirects", async () => {
    const stub = stubFetch(() => redirect(302, "https://example.com/loop"));
    const error = await failureOf(() => new Redirects().follow(stub.fetch, "https://example.com/loop"));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("stopped after 10 redirects");
    expect(stub.calls).toHaveLength(MAX_REDIRECTS + 1);
  });

  it("rejects private hosts before any fetch", async () => {
    const stub = stubFetch(() => new Response("unreachable", { status: 200 }));
    const error = await failureOf(() => new Redirects().follow(stub.fetch, "http://10.0.0.1/"));
    expect(error).toBeInstanceOf(PrivateHostError);
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects private hosts on later hops", async () => {
    const stub = stubFetch((url) =>
      url === "https://example.com/start"
        ? redirect(302, "https://10.0.0.1/")
        : new Response("unreachable", { status: 200 })
    );
    const error = await failureOf(() => new Redirects().follow(stub.fetch, "https://example.com/start"));
    expect(error).toBeInstanceOf(PrivateHostError);
    expect(stub.calls).toHaveLength(1);
  });
});

describe("Fetcher", () => {
  it("exposes a redirect policy and closes", async () => {
    const fetcher = new Fetcher();
    expect(fetcher.policy).toBeInstanceOf(Redirects);
    expect(fetcher.policy.maxRedirects).toBe(MAX_REDIRECTS);
    await fetcher.close();
  });

  it("accepts a custom redirect policy", async () => {
    const policy = new Redirects(3);
    const fetcher = new Fetcher({ policy });
    expect(fetcher.policy).toBe(policy);
    await fetcher.close();
  });
});
