import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createError, getRequestHeader, sendWebResponse } from "h3";
import { z } from "zod";

import { db } from "../../../lib/db";
import { providerAccount } from "../../../lib/db/schema";
import { readDashboardBody, requireUserId } from "../../../utils/api";

const playgroundEndpointSchema = z.enum(["chat_completions", "messages", "responses"]);
const playgroundRunInputSchema = z.object({
  endpoint: playgroundEndpointSchema,
  body: z.object({}).passthrough(),
}).strict();

const responseHeadersToForward = ["content-type", "x-provider-account-id", "retry-after"];

function getProxyBaseUrl(proxyUrl?: string) {
  const value = (proxyUrl || process.env.NUXT_PUBLIC_PROXY_URL || "").trim().replace(/\/+$/, "");
  return value || null;
}

function getEndpointPath(endpoint: z.infer<typeof playgroundEndpointSchema>) {
  if (endpoint === "messages") return "/v1/messages";
  if (endpoint === "responses") return "/v1/responses";
  return "/v1/chat/completions";
}

function signPlaygroundRequest(userId: string, timestamp: string, method: string, path: string) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw createError({ statusCode: 500, statusMessage: "BETTER_AUTH_SECRET is required" });
  return createHmac("sha256", secret).update(`${userId}\n${timestamp}\n${method}\n${path}`).digest("hex");
}

function getForwardedResponseHeaders(response: Response) {
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const header of responseHeadersToForward) {
    const value = response.headers.get(header);
    if (value) headers.set(header, value);
  }
  return headers;
}

async function hasAnyProviderAccount(userId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(providerAccount)
    .where(eq(providerAccount.userId, userId));
  return Number(row?.count ?? 0) > 0;
}

export default defineEventHandler(async (event) => {
  const userId = await requireUserId(event);
  const input = await readDashboardBody(event, playgroundRunInputSchema);
  if (!(await hasAnyProviderAccount(userId))) throw createError({ statusCode: 403, statusMessage: "Connect a provider account before running Playground" });

  const config = useRuntimeConfig(event);
  const proxyBaseUrl = getProxyBaseUrl(config.proxyUrl || config.public.proxyUrl);
  if (!proxyBaseUrl) throw createError({ statusCode: 500, statusMessage: "Proxy URL is not configured" });

  const timestamp = String(Math.floor(Date.now() / 1000));
  const method = "POST";
  const path = getEndpointPath(input.endpoint);
  const response = await fetch(`${proxyBaseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Session-Id": getRequestHeader(event, "x-session-id") ?? getRequestHeader(event, "session_id") ?? "",
      "X-Opendum-Playground-User-Id": userId,
      "X-Opendum-Playground-Timestamp": timestamp,
      "X-Opendum-Playground-Signature": signPlaygroundRequest(userId, timestamp, method, path),
    },
    body: JSON.stringify(input.body),
  });

  return sendWebResponse(event, new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: getForwardedResponseHeaders(response),
  }));
});
