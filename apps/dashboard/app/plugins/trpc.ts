import { createTRPCNuxtClient, httpBatchLink } from "trpc-nuxt/client";
import type { AppRouter } from "../../server/trpc/root";

type TrpcClient = ReturnType<typeof createTRPCNuxtClient<AppRouter>>;

export default defineNuxtPlugin(() => {
  const client = createTRPCNuxtClient<AppRouter>({
    links: [
      httpBatchLink<AppRouter>({
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
