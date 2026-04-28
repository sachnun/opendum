import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "../../server/trpc/root";

type TrpcClient = ReturnType<typeof createTRPCProxyClient<AppRouter>>;

export default defineNuxtPlugin(() => {
  const client = createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        url: "/api/trpc",
      }),
    ],
  });

  return {
    provide: {
      client,
    },
  };
});

declare module "#app" {
  interface NuxtApp {
    $client: TrpcClient;
  }
}
