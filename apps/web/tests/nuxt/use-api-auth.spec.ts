import { beforeEach, describe, expect, it, mock } from "bun:test";

import { setAuthTokens } from "~~/lib/auth-token";

const refreshAccessToken = mock(async () => false);
const expireSession = mock(() => {});
const fetchMock = mock((..._args: unknown[]) => Promise.resolve<unknown>({ ok: true }));

(globalThis as Record<string, unknown>).useAuth = () => ({
  apiUrl: "https://api.example.com",
  refreshAccessToken,
  expireSession,
});
(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({ public: { apiUrl: "https://api.example.com" } });
(globalThis as Record<string, unknown>).navigateTo = mock(() => {});
(globalThis as Record<string, unknown>).$fetch = fetchMock;

type FetchCall = [string, { headers: Record<string, string> }];

const { useApi } = await import("~/composables/useApi");

function callAt(index: number): FetchCall {
  return fetchMock.mock.calls[index] as FetchCall;
}

describe("useApi access tokens", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    localStorage.clear();
    refreshAccessToken.mockImplementation(async () => false);
    fetchMock.mockImplementation((..._args: unknown[]) => Promise.resolve<unknown>({ ok: true }));
  });

  it("sends the stored access token", async () => {
    setAuthTokens({ access: "access-token", session: "session-token" });

    await useApi().me.get();

    const [url, options] = callAt(0);
    expect(url).toBe("https://api.example.com/web/me");
    expect(options.headers.authorization).toBe("Bearer access-token");
  });

  it("refreshes once on 401 and retries", async () => {
    setAuthTokens({ access: "stale-token", session: "session-token" });
    refreshAccessToken.mockImplementation(async () => {
      setAuthTokens({ access: "fresh-token", session: "session-token" });
      return true;
    });
    fetchMock.mockImplementationOnce(async () => {
      throw { status: 401 };
    });

    await useApi().me.get();

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(callAt(1)[1].headers.authorization).toBe("Bearer fresh-token");
  });

  it("expires the session when the refresh fails", async () => {
    setAuthTokens({ access: "stale-token", session: "session-token" });
    fetchMock.mockImplementation(async () => {
      throw { status: 401 };
    });

    await expect(useApi().me.get()).rejects.toMatchObject({ status: 401 });

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(expireSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves other failures alone", async () => {
    setAuthTokens({ access: "access-token", session: "session-token" });
    fetchMock.mockImplementation(async () => {
      throw { status: 500 };
    });

    await expect(useApi().me.get()).rejects.toMatchObject({ status: 500 });

    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(expireSession).not.toHaveBeenCalled();
  });
});
