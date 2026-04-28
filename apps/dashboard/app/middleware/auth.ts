import { authClient } from "../../lib/auth-client";

export default defineNuxtRouteMiddleware(async (to) => {
  const { data: session } = await authClient.useSession(useFetch);

  if (!session.value?.user && to.path.startsWith("/dashboard")) {
    return navigateTo({ path: "/", query: { redirect: to.fullPath } });
  }
});
