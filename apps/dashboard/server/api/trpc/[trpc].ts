import { createTRPCNuxtHandler } from "trpc-nuxt/server";

import { createContext } from "../../trpc/context";
import { appRouter } from "../../trpc/root";

export default createTRPCNuxtHandler({
  router: appRouter,
  createContext,
});
