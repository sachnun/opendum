import { getProviderFromSlug } from "../../lib/provider-accounts";

const SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export default defineNuxtRouteMiddleware((to) => {
  if (to.params.provider === undefined) return;

  const slug = String(to.params.provider).trim().toLowerCase();
  if (getProviderFromSlug(slug) || SLUG_PATTERN.test(slug)) return;

  return navigateTo("/", { replace: true, redirectCode: 301 });
});
