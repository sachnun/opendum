import { stringValue } from "#providers/lib/helpers.ts";

type Json = Record<string, unknown>;

export function lastModelSegment(model: string): string {
  const parts = model.split("/");
  return parts[parts.length - 1];
}

function jwtClaims(token: string): Json | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(payload) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Json;
    return null;
  } catch {
    return null;
  }
}

function firstStringClaim(claims: Json, key: string): string {
  return stringValue(claims[key]).trim();
}

function extractOrganizationId(claims: Json): string {
  const organizations = Array.isArray(claims.organizations) ? claims.organizations : [];
  for (const preferDefault of [true, false]) {
    for (const raw of organizations) {
      const org = (raw ?? {}) as Json;
      const isDefault = org.is_default === true || org.default === true;
      if (preferDefault && !isDefault) continue;
      const value = stringValue(org.id).trim();
      if (value) return value;
    }
  }
  return "";
}

export function extractAccountIdFromJwt(token: string): string {
  const claims = jwtClaims(token);
  if (!claims) return "";
  const accountId = firstStringClaim(claims, "chatgpt_account_id");
  if (accountId) return accountId;
  return extractWorkspaceIdFromClaims(claims);
}

function extractWorkspaceIdFromClaims(claims: Json): string {
  const auth = claims["https://api.openai.com/auth"];
  const authClaims =
    auth !== null && typeof auth === "object" && !Array.isArray(auth) ? (auth as Json) : null;
  for (const source of [authClaims, claims]) {
    if (!source) continue;
    for (const key of ["chatgpt_workspace_id", "workspace_id", "organization_id"]) {
      const value = firstStringClaim(source, key);
      if (value) return value;
    }
    const orgId = extractOrganizationId(source);
    if (orgId) return orgId;
  }
  return "";
}

export function extractTierFromJwt(token: string): string {
  const claims = jwtClaims(token);
  if (!claims) return "";
  const direct = stringValue(claims.chatgpt_plan_type);
  if (direct) return direct.trim().toLowerCase();
  const auth = claims["https://api.openai.com/auth"];
  if (auth !== null && typeof auth === "object" && !Array.isArray(auth)) {
    return stringValue((auth as Json).chatgpt_plan_type).trim().toLowerCase();
  }
  return "";
}

function parseFloatString(value: string): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed > 100 ? 100 : parsed;
}

function parseIntString(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBoolString(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

function resetTimestamp(value: number | null): number | null {
  if (!value || value <= 0) return null;
  return value > 10_000_000_000 ? value : value * 1000;
}

function quotaWindow(used: string, windowMinutes: string, resetAt: string): Json {
  const usedPercent = parseFloatString(used);
  let remaining = 100 - usedPercent;
  if (remaining < 0) remaining = 0;
  const reset = parseIntString(resetAt);
  return {
    usedPercent,
    remainingPercent: remaining,
    remainingFraction: remaining / 100,
    windowMinutes: parseIntString(windowMinutes),
    resetAt: reset,
    resetTimestamp: resetTimestamp(reset),
    isExhausted: usedPercent >= 100,
  };
}

export function parseCodexQuotaHeaders(headers: Headers): Json | null {
  const primaryUsed = headers.get("x-codex-primary-used-percent") ?? "";
  const secondaryUsed = headers.get("x-codex-secondary-used-percent") ?? "";
  const credits = headers.get("x-codex-credits-has-credits") ?? "";
  if (!primaryUsed && !secondaryUsed && !credits) return null;
  const snapshot: Json = { planType: null, primary: null, secondary: null, credits: null };
  if (primaryUsed) {
    snapshot.primary = quotaWindow(
      primaryUsed,
      headers.get("x-codex-primary-window-minutes") ?? "",
      headers.get("x-codex-primary-reset-at") ?? ""
    );
  }
  if (secondaryUsed) {
    snapshot.secondary = quotaWindow(
      secondaryUsed,
      headers.get("x-codex-secondary-window-minutes") ?? "",
      headers.get("x-codex-secondary-reset-at") ?? ""
    );
  }
  if (credits) {
    snapshot.credits = {
      hasCredits: parseBoolString(credits),
      unlimited: parseBoolString(headers.get("x-codex-credits-unlimited") ?? ""),
      balance: (headers.get("x-codex-credits-balance") ?? "") || null,
    };
  }
  return snapshot;
}
