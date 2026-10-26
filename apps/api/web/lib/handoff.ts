const MAX_REDIRECT_LENGTH = 512;

export function safePath(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const path = value.trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.length > MAX_REDIRECT_LENGTH) return null;

  return path;
}

export function webOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const candidate = value.trim();
  if (!candidate) return null;

  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function handoffUrl(baseUrl: string, options: { to: string; redirect?: string | null }): string {
  const url = new URL("/api/auth/handoff", baseUrl);
  url.searchParams.set("to", options.to);

  if (options.redirect) {
    url.searchParams.set("redirect", options.redirect);
  }

  return url.toString();
}

export function loginUrl(origin: string, params: { token?: string; session?: string; redirect?: string | null; error?: string | null }): string {
  if (params.error) {
    const url = new URL("/", `${origin}/`);
    url.searchParams.set("error", params.error);
    return url.toString();
  }

  const fragment = new URLSearchParams();
  if (params.token) fragment.set("token", params.token);
  if (params.session) fragment.set("session", params.session);
  if (params.redirect) fragment.set("redirect", params.redirect);

  return `${origin}/auth/callback#${fragment.toString()}`;
}
