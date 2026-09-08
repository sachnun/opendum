import { authClient } from "../../lib/auth-client";

export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === "/") return;

  const { data: session } = await authClient.useSession(useFetch);

  if (!session.value?.user) {
    return navigateTo({ path: "/", query: { redirect: to.fullPath } });
  }
});
