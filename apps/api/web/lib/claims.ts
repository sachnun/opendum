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

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function toAuthUser(value: { id: string; name?: string | null; email?: string | null; image?: string | null }): AuthUser {
  return {
    id: value.id,
    name: value.name ?? null,
    email: value.email ?? null,
    image: value.image ?? null,
  };
}

export function claimsFromPayload(payload: unknown): AccessTokenClaims | null {
  if (!payload || typeof payload !== "object") return null;

  const record = payload as Record<string, unknown>;
  const id = text(record.sub);
  if (!id) return null;

  return {
    user: {
      id,
      name: text(record.name),
      email: text(record.email),
      image: text(record.image),
    },
    impersonatedBy: text(record.impersonatedBy),
  };
}
