import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db, providerAccount, decrypt } from "@opendum/database";
import { fetchAccountQuota } from "@opendum/ai";
import { validateInternalSignature } from "../auth/internal.js";

const INTERNAL_RELAY_MAX_BODY_BYTES = 2 * 1024 * 1024;
const INTERNAL_QUOTA_MAX_BODY_BYTES = 64 * 1024;
const INTERNAL_RELAY_TIMEOUT_MS = 20_000;
const INTERNAL_RELAY_METHODS = new Set([
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
]);
const INTERNAL_RELAY_FIELDS = new Set(["url", "method", "headers", "body"]);
const INTERNAL_QUOTA_FIELDS = new Set([
    "userId",
    "provider",
    "accountId",
    "forceRefresh",
]);

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(value: Record<string, unknown>, fields: Set<string>) {
    return Object.keys(value).every((key) => fields.has(key));
}

async function readRawBody(
    request: Request,
    maxBytes: number,
): Promise<string | null> {
    const contentLength = request.headers.get("content-length");
    if (contentLength !== null) {
        const declaredLength = Number(contentLength);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            return null;
        }
    }

    if (!request.body) {
        return "";
    }

    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
    } catch {
        return null;
    } finally {
        reader.releaseLock();
    }

    const raw = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        raw.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(raw);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isBlockedRelayRequestHeader(header: string): boolean {
    if (
        header === "" ||
        header.startsWith(":") ||
        header.startsWith("proxy-") ||
        header.startsWith("x-forwarded-")
    ) {
        return true;
    }

    return [
        "host",
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "content-length",
        "accept-encoding",
        "forwarded",
        "x-real-ip",
    ].includes(header);
}

function isBlockedRelayResponseHeader(header: string): boolean {
    if (header === "" || header.startsWith("proxy-")) {
        return true;
    }

    return [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "content-length",
        "set-cookie",
    ].includes(header);
}

export function createInternalRoute() {
    const router = new Hono();

    router.post("/internal/refresh", async (c) => {
        const rawBody = await readRawBody(
            c.req.raw,
            INTERNAL_RELAY_MAX_BODY_BYTES,
        );
        if (rawBody === null) {
            c.header("X-Opendum-Internal-Relay-Error", "1");
            return c.json({ error: "Invalid internal refresh payload" }, 400);
        }
        if (!validateInternalSignature(c, "/internal/refresh", rawBody)) {
            c.header("X-Opendum-Internal-Relay-Error", "1");
            return c.json({ error: "Invalid internal refresh signature" }, 401);
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(rawBody);
        } catch {
            c.header("X-Opendum-Internal-Relay-Error", "1");
            return c.json({ error: "Invalid internal refresh payload" }, 400);
        }

        if (
            !isObject(parsed) ||
            !hasOnlyFields(parsed, INTERNAL_RELAY_FIELDS) ||
            typeof parsed.url !== "string" ||
            (parsed.method !== undefined &&
                typeof parsed.method !== "string") ||
            (parsed.headers !== undefined &&
                (!isObject(parsed.headers) ||
                    !Object.values(parsed.headers).every(
                        (value) => typeof value === "string",
                    )))
        ) {
            c.header("X-Opendum-Internal-Relay-Error", "1");
            return c.json({ error: "Invalid internal refresh payload" }, 400);
        }

        const rawUrl = parsed.url.trim();
        if (!rawUrl) {
            c.header("X-Opendum-Internal-Relay-Error", "1");
            return c.json({ error: "url is required" }, 400);
        }

        let target: URL;
        try {
            target = new URL(rawUrl);
        } catch {
            c.header("X-Opendum-Internal-Relay-Error", "1");
            return c.json({ error: "url is invalid" }, 400);
        }
        if (
            target.protocol !== "https:" ||
            !target.hostname ||
            target.username !== "" ||
            target.password !== ""
        ) {
            c.header("X-Opendum-Internal-Relay-Error", "1");
            return c.json({ error: "url must be an https provider URL" }, 400);
        }

        const requestedMethod =
            typeof parsed.method === "string"
                ? parsed.method.trim().toUpperCase()
                : "";
        const method = requestedMethod || "GET";
        if (!INTERNAL_RELAY_METHODS.has(method)) {
            c.header("X-Opendum-Internal-Relay-Error", "1");
            return c.json(
                { error: `Unsupported internal relay method: ${method}` },
                400,
            );
        }

        const outboundHeaders = new Headers();
        try {
            if (isObject(parsed.headers)) {
                for (const [key, value] of Object.entries(parsed.headers)) {
                    const normalized = key.trim().toLowerCase();
                    if (
                        typeof value === "string" &&
                        value.trim() !== "" &&
                        !isBlockedRelayRequestHeader(normalized)
                    ) {
                        outboundHeaders.set(normalized, value);
                    }
                }
            }
        } catch {
            c.header("X-Opendum-Internal-Relay-Error", "1");
            return c.json({ error: "Invalid internal refresh payload" }, 400);
        }

        let body: BodyInit | undefined;
        if (parsed.body !== undefined && parsed.body !== null) {
            body =
                typeof parsed.body === "string"
                    ? parsed.body
                    : JSON.stringify(parsed.body);
        }

        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(),
            INTERNAL_RELAY_TIMEOUT_MS,
        );
        try {
            const resp = await fetch(target, {
                method,
                headers: outboundHeaders,
                body,
                signal: controller.signal,
            });

            const respHeaders = new Headers();
            resp.headers.forEach((value, key) => {
                if (!isBlockedRelayResponseHeader(key.toLowerCase())) {
                    respHeaders.set(key, value);
                }
            });

            const respBody = await resp.arrayBuffer();
            return new Response(respBody, {
                status: resp.status,
                headers: respHeaders,
            });
        } catch (error: unknown) {
            c.header("X-Opendum-Internal-Relay-Error", "1");
            return c.json(
                {
                    error: `Internal relay upstream request failed: ${errorMessage(error)}`,
                },
                502,
            );
        } finally {
            clearTimeout(timeout);
        }
    });

    router.post("/internal/quota", async (c) => {
        const rawBody = await readRawBody(
            c.req.raw,
            INTERNAL_QUOTA_MAX_BODY_BYTES,
        );
        if (rawBody === null) {
            return c.json(
                { success: false, error: "Invalid quota payload" },
                400,
            );
        }
        if (!validateInternalSignature(c, "/internal/quota", rawBody)) {
            return c.json(
                { success: false, error: "Invalid internal quota signature" },
                401,
            );
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(rawBody);
        } catch {
            return c.json(
                { success: false, error: "Invalid quota payload" },
                400,
            );
        }

        if (
            !isObject(parsed) ||
            !hasOnlyFields(parsed, INTERNAL_QUOTA_FIELDS) ||
            typeof parsed.userId !== "string" ||
            typeof parsed.provider !== "string" ||
            typeof parsed.accountId !== "string" ||
            (parsed.forceRefresh !== undefined &&
                typeof parsed.forceRefresh !== "boolean")
        ) {
            return c.json(
                { success: false, error: "Invalid quota payload" },
                400,
            );
        }

        const userId = parsed.userId.trim();
        const provider = parsed.provider.trim();
        const accountId = parsed.accountId.trim();
        if (!userId || !provider || !accountId) {
            return c.json(
                {
                    success: false,
                    error: "userId, provider, and accountId are required",
                },
                400,
            );
        }

        const [account] = await db
            .select()
            .from(providerAccount)
            .where(
                and(
                    eq(providerAccount.id, accountId),
                    eq(providerAccount.userId, userId),
                    eq(providerAccount.provider, provider),
                ),
            )
            .limit(1);

        if (!account) {
            return c.json({ success: false, error: "Account not found" }, 404);
        }

        try {
            const credentials = account.apiKey
                ? decrypt(account.apiKey)
                : decrypt(account.accessToken);
            const quotaResult = await fetchAccountQuota(account, credentials);

            return c.json({
                success: true,
                data: quotaResult,
            });
        } catch (error: unknown) {
            return c.json({ success: false, error: errorMessage(error) });
        }
    });

    return router;
}
