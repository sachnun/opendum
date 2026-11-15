import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import type { H3Event } from "h3";
import { emptyResult, type AuthResult } from "@opendum/auth/types";
import { protectedResourceMetadata, MCP_SCOPE } from "@opendum/api/mcp/auth";
import { mcpEndpoint } from "@opendum/api/mcp/endpoint";
import type { McpContext } from "@opendum/api/mcp/types";

const VALID_RESULT: AuthResult = {
  valid: true,
  userId: "user-1",
  apiKeyId: "key-1",
  modelAccessMode: "all",
  modelAccessList: [],
  accountAccessMode: "all",
  accountAccessList: [],
  roamingEnabled: false,
  rateLimitRules: [],
  error: "",
};

function authContext(result: AuthResult | Error): McpContext {
  return {
    auth: { validateKey: () => (result instanceof Error ? Effect.die(result) : Effect.succeed(result)) },
  } as unknown as McpContext;
}

function fakeHandler(): { handler: McpHttpHandler; captured: Array<Record<string, unknown> | undefined> } {
  const captured: Array<Record<string, unknown> | undefined> = [];
  const handler = {
    fetch: async (request: Request, options?: { authInfo?: unknown }) => {
      captured.push(options as Record<string, unknown> | undefined);
      return Response.json(options?.authInfo ?? {}, { status: 200 });
    },
    close: async () => {},
    notify: {},
    bus: {},
  } as unknown as McpHttpHandler;
  return { handler, captured };
}

function eventFor(request: Request): H3Event {
  return { req: request } as unknown as H3Event;
}

function mcpRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:4001/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
}

test("requests without a bearer token get a 401 challenge pointing at the metadata document", async () => {
  const { handler } = fakeHandler();
  const serve = mcpEndpoint(authContext(VALID_RESULT), handler);
  const response = await serve(eventFor(mcpRequest()));

  expect(response.status).toBe(401);
  const challenge = response.headers.get("www-authenticate") ?? "";
  expect(challenge).toContain('resource_metadata="http://localhost:4001/.well-known/oauth-protected-resource/mcp"');
});

test("requests with an invalid key get a 401 invalid_token challenge", async () => {
  const { handler } = fakeHandler();
  const serve = mcpEndpoint(authContext(emptyResult("Invalid API key")), handler);
  const response = await serve(eventFor(mcpRequest({ authorization: "Bearer bad-key" })));

  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate") ?? "").toContain('error="invalid_token"');
});

test("a valid key is forwarded to the handler as verified authInfo", async () => {
  const { handler, captured } = fakeHandler();
  const serve = mcpEndpoint(authContext(VALID_RESULT), handler);
  const response = await serve(eventFor(mcpRequest({ authorization: "Bearer opendum-key" })));

  expect(response.status).toBe(200);
  expect(captured).toHaveLength(1);
  const authInfo = captured[0]?.authInfo as { clientId?: string; scopes?: string[] } | undefined;
  expect(authInfo?.clientId).toBe("key-1");
  expect(authInfo?.scopes).toEqual([MCP_SCOPE]);
});

test("key store failures surface as server errors", async () => {
  const { handler } = fakeHandler();
  const serve = mcpEndpoint(authContext(new Error("database unreachable")), handler);
  const response = await serve(eventFor(mcpRequest({ authorization: "Bearer opendum-key" })));

  expect(response.status).toBe(500);
});

test("the protected resource metadata document advertises the mcp endpoint", async () => {
  const response = protectedResourceMetadata(new Request("http://localhost:4001/.well-known/oauth-protected-resource/mcp"));
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.resource).toBe("http://localhost:4001/mcp");
  expect(body.scopes_supported).toEqual([MCP_SCOPE]);
});
