import { Hono } from "hono";
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

  return router;
}
