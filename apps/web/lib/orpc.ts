import type { ApiContractClient } from "@opendum/providers/contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

import { getAccessToken } from "./auth-token";

export interface CreateApiClientOptions {
  baseUrl: string;
  refresh: () => Promise<boolean>;
}

export function createApiClient({ baseUrl, refresh }: CreateApiClientOptions): ApiContractClient {
  const link = new RPCLink({
    url: `${baseUrl}/rpc`,
    headers: () => {
      const token = getAccessToken();
      return token ? { authorization: `Bearer ${token}` } : {};
    },
    fetch: async (request) => {
      const response = await fetch(request.clone());
      if (response.status !== 401) return response;
      if (!(await refresh())) return response;

      const token = getAccessToken();
      const headers = new Headers(request.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);
      return fetch(new Request(request, { headers }));
    },
  });

  return createORPCClient(link);
}
