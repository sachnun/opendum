import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db, providerAccount, decrypt } from "@opendum/database";
import { fetchAccountQuota } from "@opendum/ai";
import { validateInternalSignature } from "../auth/internal.js";

export function createInternalRoute() {
  const router = new Hono();

  router.post("/internal/refresh", async (c) => {
    const rawBody = await c.req.text();
    if (!validateInternalSignature(c, "/internal/refresh", rawBody)) {
      c.header("X-Opendum-Internal-Relay-Error", "1");
      return c.json({ error: "Invalid internal refresh signature" }, 401);
    }

    let payload: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      c.header("X-Opendum-Internal-Relay-Error", "1");
      return c.json({ error: "Invalid internal refresh payload" }, 400);
    }

    if (!payload.url || !payload.url.startsWith("https://")) {
      c.header("X-Opendum-Internal-Relay-Error", "1");
      return c.json({ error: "url must be an https provider URL" }, 400);
    }

    try {
      const resp = await fetch(payload.url, {
        method: payload.method || "GET",
        headers: payload.headers,
        body: payload.body
          ? typeof payload.body === "string"
            ? payload.body
            : JSON.stringify(payload.body)
          : undefined,
      });

      const respHeaders = new Headers();
      resp.headers.forEach((val, key) => {
        const lower = key.toLowerCase();
        if (
          !lower.startsWith("proxy-") &&
          ![
            "connection",
            "keep-alive",
            "transfer-encoding",
            "set-cookie",
          ].includes(lower)
        ) {
          respHeaders.set(key, val);
        }
      });

      const respBody = await resp.arrayBuffer();
      return new Response(respBody, {
        status: resp.status,
        headers: respHeaders,
      });
    } catch (err: any) {
      c.header("X-Opendum-Internal-Relay-Error", "1");
      return c.json(
        {
          error: `Internal relay upstream request failed: ${err?.message || err}`,
        },
        502
      );
    }
  });

  router.post("/internal/quota", async (c) => {
    const rawBody = await c.req.text();
    if (!validateInternalSignature(c, "/internal/quota", rawBody)) {
      return c.json({ success: false, error: "Invalid internal quota signature" }, 401);
    }

    let payload: {
      userId: string;
      provider: string;
      accountId: string;
      forceRefresh?: boolean;
    };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ success: false, error: "Invalid quota payload" }, 400);
    }

    const { userId, provider, accountId } = payload;
    if (!userId || !provider || !accountId) {
      return c.json({ success: false, error: "userId, provider, and accountId are required" }, 400);
    }

    const [account] = await db
      .select()
      .from(providerAccount)
      .where(
        and(
          eq(providerAccount.id, accountId),
          eq(providerAccount.userId, userId),
          eq(providerAccount.provider, provider)
        )
      )
      .limit(1);

    if (!account) {
      return c.json({ success: false, error: "Account not found" }, 404);
    }

    let credentials = "";
    try {
      credentials = account.apiKey
        ? decrypt(account.apiKey)
        : decrypt(account.accessToken);
    } catch {
      // ignore
    }

    const quotaResult = await fetchAccountQuota(account, credentials);

    return c.json({
      success: true,
      data: quotaResult,
    });
  });

  return router;
}
