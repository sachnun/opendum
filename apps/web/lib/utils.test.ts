import { expect, test } from "bun:test";

import { avatarUrl, cn, messageOf } from "~~/lib/utils";

test("messageOf prefers the most specific message", () => {
  expect(messageOf(new Error("boom"))).toBe("boom");
  expect(messageOf({ data: { statusMessage: "status-message" } })).toBe("status-message");
  expect(messageOf({ data: { message: "data-message" } })).toBe("data-message");
  expect(messageOf({ statusMessage: "top-status" })).toBe("top-status");
  expect(messageOf({ message: "top-message" })).toBe("top-message");
});

test("messageOf falls back for unknown errors", () => {
  expect(messageOf(null)).toBe("Request failed. Please try again.");
  expect(messageOf({}, "custom fallback")).toBe("custom fallback");
  expect(messageOf("string error")).toBe("Request failed. Please try again.");
});

test("avatarUrl resizes GitHub and Google avatars", () => {
  expect(avatarUrl("https://avatars.githubusercontent.com/u/1?v=4", 128).includes("s=128")).toBeTruthy();
  expect(avatarUrl("https://lh3.googleusercontent.com/a/user", 96)).toBe("https://lh3.googleusercontent.com/a/user=s96-c");
  expect(avatarUrl("https://lh3.googleusercontent.com/a/user=s64-c", 96)).toBe("https://lh3.googleusercontent.com/a/user=s96-c");
});

test("avatarUrl leaves unrelated urls untouched", () => {
  expect(avatarUrl("https://example.test/avatar.png", 96)).toBe("https://example.test/avatar.png");
});

test("cn merges conflicting tailwind classes and drops falsy values", () => {
  expect(cn("p-4", "p-2")).toBe("p-2");
  expect(cn("text-left", false, undefined, "font-bold")).toBe("text-left font-bold");
});
