import { getProviderFromSlug } from "../../lib/provider-accounts";

export default defineNuxtRouteMiddleware((to) => {
  if (to.params.provider === undefined) return;

  const slug = String(to.params.provider).trim().toLowerCase();
  if (!getProviderFromSlug(slug)) {
    return navigateTo("/", { replace: true, redirectCode: 301 });
  }
});
