export const Routes = {
  home: "/",
  accounts: "/accounts",
  models: "/models",
  apiKeys: "/api-keys",
  playground: "/playground",
  authCallback: "/auth/callback",
} as const;

const PARENTS = new Set<string>(Object.values(Routes));

export function isHome(path: string): boolean {
  return path === Routes.home || path === Routes.accounts;
}

export function parentRoute(path: string): string {
  const segments = path.split("/").filter(Boolean);

  while (segments.length > 0) {
    segments.pop();
    const candidate = `/${segments.join("/")}`;
    if (PARENTS.has(candidate)) return candidate;
  }

  return Routes.home;
}
