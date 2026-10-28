import { providerOf } from "@opendum/providers/provider-accounts";
import { parentRoute } from "~~/lib/routes";

const SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export default defineNuxtRouteMiddleware((to) => {
  const provider = "provider" in to.params ? to.params.provider : undefined;
  if (provider === undefined) return;

  const slug = String(provider).trim().toLowerCase();
  if (providerOf(slug) || SLUG_PATTERN.test(slug)) return;

  return navigateTo({ path: parentRoute(to.path), query: to.query, hash: to.hash }, { replace: true });
});
