import { accountsRouter } from "./routers/accounts";
import { analyticsRouter } from "./routers/analytics";
import { apiKeysRouter } from "./routers/apiKeys";
import { modelsRouter } from "./routers/models";
import { playgroundRouter } from "./routers/playground";
import { router } from "./init";

export const appRouter = router({
  analytics: analyticsRouter,
  apiKeys: apiKeysRouter,
  models: modelsRouter,
  accounts: accountsRouter,
  playground: playgroundRouter,
});

export type AppRouter = typeof appRouter;
