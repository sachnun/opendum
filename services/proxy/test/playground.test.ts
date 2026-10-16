import { describe, expect, it } from "bun:test";
import { playgroundSignature } from "@opendum/core/crypto";
import { Playground } from "../core/playground.js";

const SECRET = "playground-secret";
const REQUEST_PATH = "/v1/chat/completions";
const REQUEST_URL = `http://localhost${REQUEST_PATH}`;

function signedRequest(
  options: {
    userId?: string;
    timestamp?: string;
    method?: string;
    url?: string;
    secret?: string;
    signature?: string;
  } = {}
): Request {
  const userId = options.userId ?? "user-1";
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const method = options.method ?? "POST";
  const url = options.url ?? REQUEST_URL;
  const signature =
    options.signature ??
    playgroundSignature(options.secret ?? SECRET, userId, timestamp, method, new URL(url).pathname);
  const headers = new Headers({
    "x-opendum-playground-user-id": userId,
    "x-opendum-playground-timestamp": timestamp,
    "x-opendum-playground-signature": signature,
  });
  return new Request(url, { method, headers });
}

describe("Playground", () => {
  const authenticator = new Playground(SECRET);

  it("falls through when the request has no playground headers", () => {
    const outcome = authenticator.authenticate(new Request(REQUEST_URL, { method: "POST" }));
    expect(outcome.handled).toBe(false);
    expect(outcome.result.valid).toBe(false);
  });

  it("falls through when the request is missing", () => {
    const outcome = authenticator.authenticate(undefined);
    expect(outcome.handled).toBe(false);
  });

  it("accepts a freshly signed request", () => {
    const outcome = authenticator.authenticate(signedRequest());
    expect(outcome.handled).toBe(true);
    expect(outcome.result.valid).toBe(true);
    expect(outcome.result.userId).toBe("user-1");
    expect(outcome.result.error).toBe("");
  });

  it("rejects a tampered signature", () => {
    const outcome = authenticator.authenticate(signedRequest({ signature: "deadbeef" }));
    expect(outcome.handled).toBe(true);
    expect(outcome.result.valid).toBe(false);
    expect(outcome.result.error).toBe("Invalid playground session");
  });

  it("rejects signatures for a different path", () => {
    const signature = playgroundSignature(SECRET, "user-1", String(Math.floor(Date.now() / 1000)), "POST", "/other");
    const outcome = authenticator.authenticate(signedRequest({ signature }));
    expect(outcome.handled).toBe(true);
    expect(outcome.result.valid).toBe(false);
  });

  it("rejects signatures for a different method", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = playgroundSignature(SECRET, "user-1", timestamp, "POST", REQUEST_PATH);
    const outcome = authenticator.authenticate(signedRequest({ signature, method: "GET" }));
    expect(outcome.handled).toBe(true);
    expect(outcome.result.valid).toBe(false);
  });

  it("rejects expired timestamps", () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 3 * 60);
    const outcome = authenticator.authenticate(signedRequest({ timestamp }));
    expect(outcome.handled).toBe(true);
    expect(outcome.result.valid).toBe(false);
  });

  it("rejects timestamps too far in the future", () => {
    const timestamp = String(Math.floor(Date.now() / 1000) + 3 * 60);
    const outcome = authenticator.authenticate(signedRequest({ timestamp }));
    expect(outcome.handled).toBe(true);
    expect(outcome.result.valid).toBe(false);
  });

  it("rejects malformed timestamps", () => {
    const outcome = authenticator.authenticate(signedRequest({ timestamp: "not-a-number" }));
    expect(outcome.handled).toBe(true);
    expect(outcome.result.valid).toBe(false);
  });

  it("rejects incomplete header sets", () => {
    const headers = new Headers({ "x-opendum-playground-user-id": "user-1" });
    const outcome = authenticator.authenticate(new Request(REQUEST_URL, { method: "POST", headers }));
    expect(outcome.handled).toBe(true);
    expect(outcome.result.valid).toBe(false);
  });

  it("rejects requests when no secret is configured", () => {
    const anonymous = new Playground("");
    const outcome = anonymous.authenticate(signedRequest({ secret: "" }));
    expect(outcome.handled).toBe(true);
    expect(outcome.result.valid).toBe(false);
  });
});
