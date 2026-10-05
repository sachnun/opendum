import { mapSlice, type Json } from "#providers/providers/antigravity/config.ts";
import { isPaidGoogleTierId, normalizeGoogleTierId } from "#providers/providers/antigravity/model-config.ts";
import {
  ANTIGRAVITY_API_CLIENT,
  ANTIGRAVITY_CLIENT_METADATA,
  ANTIGRAVITY_DEFAULT_PROJECT,
  ANTIGRAVITY_LOAD_ENDPOINTS,
  ANTIGRAVITY_ONBOARD_ENDPOINTS,
  ANTIGRAVITY_USER_AGENT,
  type AntigravityRuntime,
} from "#providers/providers/antigravity/runtime.ts";

export type AccountInfo = { projectId: string; tier: string; paidTier: string; email: string };

function codeAssistMetadata(): Json {
  return { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };
}

export function setGoogleHeaders(headers: Record<string, string>, accessToken: string, stream: boolean): void {
  headers.Authorization = `Bearer ${accessToken.trim()}`;
  headers["Content-Type"] = "application/json";
  headers.Accept = stream ? "text/event-stream" : "application/json";
  if (ANTIGRAVITY_USER_AGENT) headers["User-Agent"] = ANTIGRAVITY_USER_AGENT;
  if (ANTIGRAVITY_API_CLIENT) headers["X-Goog-Api-Client"] = ANTIGRAVITY_API_CLIENT;
  if (ANTIGRAVITY_CLIENT_METADATA) headers["Client-Metadata"] = ANTIGRAVITY_CLIENT_METADATA;
}

function extractGoogleProjectId(data: Json): string {
  const value = stringValueOf(data.cloudaicompanionProject);
  if (value) return value;
  const project = data.cloudaicompanionProject;
  if (project !== null && typeof project === "object" && !Array.isArray(project)) {
    return stringValueOf((project as Json).id);
  }
  return "";
}

function extractGoogleTier(data: Json): string {
  const value = stringValueOf(data.currentTier);
  if (value) return normalizeGoogleTierId(value);
  const tier = data.currentTier;
  if (tier !== null && typeof tier === "object" && !Array.isArray(tier)) {
    const id = stringValueOf((tier as Json).id);
    if (id) return normalizeGoogleTierId(id);
    return normalizeGoogleTierId(stringValueOf((tier as Json).name));
  }
  return "";
}

function extractPaidGoogleTier(data: Json): string {
  const paidTier = data.paidTier;
  if (paidTier === null || typeof paidTier !== "object" || Array.isArray(paidTier)) return "";
  const id = normalizeGoogleTierId(stringValueOf((paidTier as Json).id));
  return id && id !== "free-tier" ? id : "";
}

function extractAllowedTiers(data: Json): Json[] {
  return mapSlice(data.allowedTiers);
}

function detectAntigravityTier(data: Json): string {
  let detected = "";
  for (const tier of extractAllowedTiers(data)) {
    if (tier.isDefault === true) {
      detected = normalizeGoogleTierId(stringValueOf(tier.id));
      break;
    }
  }
  const paidTier = data.paidTier;
  if (paidTier !== null && typeof paidTier === "object" && !Array.isArray(paidTier)) {
    const id = normalizeGoogleTierId(stringValueOf((paidTier as Json).id));
    if (id && isPaidGoogleTierId(id)) return id;
  }
  return detected;
}

function selectOnboardTier(fallback: string, allowedTiers: Json[]): string {
  for (const tier of allowedTiers) {
    if (tier.isDefault === true) {
      const id = stringValueOf(tier.id);
      if (id) return id;
    }
  }
  for (const tier of allowedTiers) {
    if (stringValueOf(tier.id) === "legacy-tier") return "legacy-tier";
  }
  if (allowedTiers.length > 0) return stringValueOf(allowedTiers[0].id);
  return fallback || "free-tier";
}

function stringValueOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function postOnboardUser(
  rt: AntigravityRuntime,
  accessToken: string,
  endpoint: string,
  payload: string
): Promise<Json | null> {
  const headers: Record<string, string> = {};
  setGoogleHeaders(headers, accessToken, false);
  try {
    const resp = await rt.transport.direct(`${endpoint}/v1internal:onboardUser`, {
      method: "POST",
      headers,
      body: payload,
    });
    if (resp.status < 200 || resp.status >= 300) return null;
    return (await resp.json()) as Json;
  } catch {
    return null;
  }
}

async function onboardUser(
  rt: AntigravityRuntime,
  accessToken: string,
  tier: string,
  allowedTiers: Json[]
): Promise<AccountInfo> {
  if (allowedTiers.length === 0) return { projectId: "", tier: "", paidTier: "", email: "" };
  const onboardTier = selectOnboardTier(tier, allowedTiers);
  if (!onboardTier) return { projectId: "", tier: "", paidTier: "", email: "" };
  const payload = JSON.stringify({ tierId: onboardTier, metadata: codeAssistMetadata() });
  for (const endpoint of ANTIGRAVITY_ONBOARD_ENDPOINTS) {
    let data = await postOnboardUser(rt, accessToken, endpoint, payload);
    if (!data) continue;
    for (let i = 0; i < 30 && data.done === false; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const polled = await postOnboardUser(rt, accessToken, endpoint, payload);
      if (polled) data = polled;
    }
    if (data.done === false) continue;
    const response = data.response;
    if (response !== null && typeof response === "object" && !Array.isArray(response)) data = response as Json;
    const project = extractGoogleProjectId(data);
    if (project) return { projectId: project, tier: normalizeGoogleTierId(onboardTier), paidTier: "", email: "" };
  }
  return { projectId: "", tier: "", paidTier: "", email: "" };
}

async function fetchGoogleEmail(rt: AntigravityRuntime, accessToken: string): Promise<string> {
  const headers: Record<string, string> = {};
  setGoogleHeaders(headers, accessToken, false);
  try {
    const resp = await rt.transport.direct("https://www.googleapis.com/oauth2/v2/userinfo", { headers });
    if (resp.status < 200 || resp.status >= 300) return "";
    const data = (await resp.json()) as Json;
    return stringValueOf(data.email);
  } catch {
    return "";
  }
}

export async function fetchAccountInfo(rt: AntigravityRuntime, accessToken: string): Promise<AccountInfo> {
  const info: AccountInfo = { projectId: "", tier: "free-tier", paidTier: "", email: "" };
  let currentTierPresent = false;
  let allowedTiers: Json[] = [];
  let hadError = false;
  for (const endpoint of ANTIGRAVITY_LOAD_ENDPOINTS) {
    const headers: Record<string, string> = {};
    setGoogleHeaders(headers, accessToken, false);
    let resp: Response;
    try {
      resp = await rt.transport.direct(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers,
        body: JSON.stringify({ metadata: codeAssistMetadata() }),
      });
    } catch {
      hadError = true;
      continue;
    }
    let data: Json = {};
    if (resp.status >= 200 && resp.status < 300) {
      try {
        data = (await resp.json()) as Json;
      } catch {
        data = {};
      }
    } else {
      hadError = true;
    }
    if (Object.keys(data).length === 0) continue;
    const project = extractGoogleProjectId(data);
    if (project) info.projectId = project;
    if (data.currentTier !== undefined) currentTierPresent = true;
    const currentTierId = extractGoogleTier(data);
    if (currentTierId) info.tier = currentTierId;
    const tiers = extractAllowedTiers(data);
    if (tiers.length > 0) allowedTiers = tiers;
    if (!currentTierId) {
      const tier = detectAntigravityTier(data);
      if (tier) info.tier = tier;
    }
    const paidTier = extractPaidGoogleTier(data);
    if (paidTier) info.paidTier = paidTier;
    if (info.projectId) break;
  }
  if (!info.projectId && !currentTierPresent) {
    const onboard = await onboardUser(rt, accessToken, info.tier, allowedTiers);
    if (onboard.projectId) {
      info.projectId = onboard.projectId;
      info.tier = onboard.tier;
    }
  }
  if (info.projectId === "" && hadError) info.projectId = ANTIGRAVITY_DEFAULT_PROJECT;
  info.email = await fetchGoogleEmail(rt, accessToken);
  return info;
}
