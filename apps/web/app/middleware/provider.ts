import { getProviderFromSlug } from "@opendum/providers/provider-accounts";

const SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export default defineNuxtRouteMiddleware((to) => {
  const provider = "provider" in to.params ? to.params.provider : undefined;
  if (provider === undefined) return;

  const slug = String(provider).trim().toLowerCase();
  if (getProviderFromSlug(slug) || SLUG_PATTERN.test(slug)) return;

  return navigateTo("/", { replace: true, redirectCode: 301 });
});
