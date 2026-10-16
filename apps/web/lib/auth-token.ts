export interface AuthUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

export interface AccessTokenClaims {
  user: AuthUser;
  impersonatedBy: string | null;
}

const ACCESS_TOKEN_KEY = "opendum.auth.access-token";
const SESSION_TOKEN_KEY = "opendum.auth.session-token";
const IMPERSONATION_TOKEN_KEY = "opendum.auth.impersonation-token";

function storage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function getAccessToken(): string | null {
  return storage()?.getItem(ACCESS_TOKEN_KEY) ?? null;
}

export function getSessionToken(): string | null {
  return storage()?.getItem(SESSION_TOKEN_KEY) ?? null;
}

export function getImpersonationToken(): string | null {
  return storage()?.getItem(IMPERSONATION_TOKEN_KEY) ?? null;
}

export function getActiveSessionToken(): string | null {
  return getImpersonationToken() ?? getSessionToken();
}

export function setAccessToken(token: string): void {
  storage()?.setItem(ACCESS_TOKEN_KEY, token);
}

export function setAuthTokens(tokens: { access: string; session: string }): void {
  const store = storage();
  store?.setItem(ACCESS_TOKEN_KEY, tokens.access);
  store?.setItem(SESSION_TOKEN_KEY, tokens.session);
  store?.removeItem(IMPERSONATION_TOKEN_KEY);
}

export function setImpersonationToken(token: string | null): void {
  const store = storage();
  if (token) store?.setItem(IMPERSONATION_TOKEN_KEY, token);
  else store?.removeItem(IMPERSONATION_TOKEN_KEY);
}

export function clearAuthTokens(): void {
  const store = storage();
  store?.removeItem(ACCESS_TOKEN_KEY);
  store?.removeItem(SESSION_TOKEN_KEY);
  store?.removeItem(IMPERSONATION_TOKEN_KEY);
}

function decodeSegment(segment: string): unknown {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

  return JSON.parse(new TextDecoder().decode(bytes));
}

function toAuthUser(value: unknown): AuthUser | null {
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const id = text(record.id);
  if (!id) return null;

  return {
    id,
    name: text(record.name),
    email: text(record.email),
    image: text(record.image),
  };
}

export function readAccessClaims(token: string | null = getAccessToken()): AccessTokenClaims | null {
  if (!token) return null;

  const payload = token.split(".")[1];
  if (!payload) return null;

  try {
    const decoded = decodeSegment(payload) as Record<string, unknown>;
    const user = toAuthUser({ id: decoded.sub, name: decoded.name, email: decoded.email, image: decoded.image });
    if (!user) return null;

    return { user, impersonatedBy: text(decoded.impersonatedBy) };
  } catch {
    return null;
  }
}
