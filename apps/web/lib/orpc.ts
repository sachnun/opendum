import type { ApiContractClient } from "@opendum/providers/contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

import { accessToken } from "~~/lib/auth-token";

export interface ClientOptions {
  baseUrl: string;
  refresh: () => Promise<boolean>;
  expire: () => void;
}

export function apiClient({ baseUrl, refresh, expire }: ClientOptions): ApiContractClient {
  const link = new RPCLink({
    url: `${baseUrl}/rpc`,
    headers: () => {
      const token = accessToken();
      return token ? { authorization: `Bearer ${token}` } : {};
    },
    fetch: async (request) => {
      const response = await fetch(request.clone());
      if (response.status !== 401) return response;

      if (!(await refresh())) {
        expire();
        return response;
      }

      const token = accessToken();
      const headers = new Headers(request.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);

      const retried = await fetch(new Request(request, { headers }));
      if (retried.status === 401) expire();

      return retried;
    },
  });

  return createORPCClient(link);
}
