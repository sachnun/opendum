import { beforeEach, describe, expect, it, mock } from "bun:test";

import { setTokens } from "~~/lib/auth-token";

const refreshAccessToken = mock(async () => false);
const expireSession = mock(() => {});

const requests: Request[] = [];
let responder: () => Response = () => jsonResponse();

function jsonResponse(body: unknown = {}, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const request = input instanceof Request ? input : new Request(String(input));
  requests.push(request.clone());
  return responder();
}) as typeof fetch;

const { apiClient } = await import("~~/lib/orpc");

function createClient() {
  return apiClient({
    baseUrl: "https://api.example.com",
    refresh: async () => {
      if (await refreshAccessToken()) return true;

      expireSession();
      return false;
    },
  });
}

async function callMe(client: ReturnType<typeof createClient>) {
  try {
    await client.session.get({});
  } catch {}
}

describe("api client access tokens", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    requests.length = 0;
    localStorage.clear();
    refreshAccessToken.mockImplementation(async () => false);
    responder = () => jsonResponse();
  });

  it("sends the stored access token", async () => {
    setTokens({ access: "access-token", session: "session-token" });

    await callMe(createClient());

    expect(requests[0]?.headers.get("authorization")).toBe("Bearer access-token");
  });

  it("refreshes once on 401 and retries with the fresh token", async () => {
    setTokens({ access: "stale-token", session: "session-token" });
    refreshAccessToken.mockImplementation(async () => {
      setTokens({ access: "fresh-token", session: "session-token" });
      return true;
    });
    let calls = 0;
    responder = () => (++calls === 1 ? jsonResponse({}, 401) : jsonResponse());

    await callMe(createClient());

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers.get("authorization")).toBe("Bearer fresh-token");
  });

  it("expires the session when the refresh fails", async () => {
    setTokens({ access: "stale-token", session: "session-token" });
    responder = () => jsonResponse({}, 401);

    await callMe(createClient());

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(expireSession).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  it("leaves other failures alone", async () => {
    setTokens({ access: "access-token", session: "session-token" });
    responder = () => jsonResponse({}, 500);

    await callMe(createClient());

    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(expireSession).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });
});
