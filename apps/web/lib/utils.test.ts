import { test } from "node:test";
import assert from "node:assert/strict";

import { avatarUrl, cn, requestErrorMessage } from "./utils";

test("requestErrorMessage prefers the most specific message", () => {
  assert.equal(requestErrorMessage(new Error("boom")), "boom");
  assert.equal(requestErrorMessage({ data: { statusMessage: "status-message" } }), "status-message");
  assert.equal(requestErrorMessage({ data: { message: "data-message" } }), "data-message");
  assert.equal(requestErrorMessage({ statusMessage: "top-status" }), "top-status");
  assert.equal(requestErrorMessage({ message: "top-message" }), "top-message");
});

test("requestErrorMessage falls back for unknown errors", () => {
  assert.equal(requestErrorMessage(null), "Request failed. Please try again.");
  assert.equal(requestErrorMessage({}, "custom fallback"), "custom fallback");
  assert.equal(requestErrorMessage("string error"), "Request failed. Please try again.");
});

test("avatarUrl resizes GitHub and Google avatars", () => {
  assert.ok(avatarUrl("https://avatars.githubusercontent.com/u/1?v=4", 128).includes("s=128"));
  assert.equal(
    avatarUrl("https://lh3.googleusercontent.com/a/user", 96),
    "https://lh3.googleusercontent.com/a/user=s96-c",
  );
  assert.equal(
    avatarUrl("https://lh3.googleusercontent.com/a/user=s64-c", 96),
    "https://lh3.googleusercontent.com/a/user=s96-c",
  );
});

test("avatarUrl leaves unrelated urls untouched", () => {
  assert.equal(avatarUrl("https://example.test/avatar.png", 96), "https://example.test/avatar.png");
});

test("cn merges conflicting tailwind classes and drops falsy values", () => {
  assert.equal(cn("p-4", "p-2"), "p-2");
  assert.equal(cn("text-left", false, undefined, "font-bold"), "text-left font-bold");
});
