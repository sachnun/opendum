import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { internalSignature } from "@opendum/crypto";
import { validateInternalSignature } from "../src/middleware/internal-signature.ts";

function request(headers: Record<string, string>): Request {
  return new Request("https://proxy/internal", { headers });
}

function signed(secret: string, path: string, body: string, timestampSeconds: number): Request {
  return request({
    "x-opendum-internal-timestamp": String(timestampSeconds),
    "x-opendum-internal-signature": internalSignature(secret, String(timestampSeconds), path, body),
  });
}

describe("validateInternalSignature", () => {
  it("rejects missing or malformed input", async () => {
    assert.equal(await validateInternalSignature("", request({}), "/p", ""), false);
    assert.equal(await validateInternalSignature("s", request({}), "/p", ""), false);
    assert.equal(
      await validateInternalSignature("s", request({ "x-opendum-internal-timestamp": "nope", "x-opendum-internal-signature": "x" }), "/p", ""),
      false
    );
  });

  it("rejects stale and future timestamps", async () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal(await validateInternalSignature("s", signed("s", "/p", "", now - 3600), "/p", ""), false);
    assert.equal(await validateInternalSignature("s", signed("s", "/p", "", now + 3600), "/p", ""), false);
  });

  it("accepts valid signatures and rejects mismatches", async () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal(await validateInternalSignature("s", signed("s", "/p", "body", now), "/p", "body"), true);
    assert.equal(await validateInternalSignature("s", signed("s", "/p", "body", now), "/other", "body"), false);
    assert.equal(
      await validateInternalSignature(
        "s",
        request({ "x-opendum-internal-timestamp": String(now), "x-opendum-internal-signature": "abcd" }),
        "/p",
        ""
      ),
      false
    );
  });
});
