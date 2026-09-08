export default defineNuxtRouteMiddleware((to) => {
  if (!to.path.startsWith("/dashboard")) return;

  const slug = to.path.slice("/dashboard".length) || "/";
  const legacyMap: Record<string, string> = {
    "/": "/",
    "/api-keys": "/keys",
    "/models": "/models",
    "/playground": "/play",
  };

  const target = legacyMap[slug] ?? slug;
  return navigateTo({ path: target, query: to.query, hash: to.hash }, { redirectCode: 301 });
});
