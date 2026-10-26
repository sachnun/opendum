import { expect, test } from "bun:test";

import { normalizeEmail } from "@opendum/database/email";

test("normalizeEmail trims and lowercases", () => {
  expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com");
});

test("normalizeEmail strips plus suffix on any domain", () => {
  expect(normalizeEmail("First.Last+news@example.com")).toBe("first.last@example.com");
  expect(normalizeEmail("First.Last+news@googlemail.com")).toBe("first.last@googlemail.com");
});

test("normalizeEmail keeps dots on every domain", () => {
  expect(normalizeEmail("first.last@gmail.com")).toBe("first.last@gmail.com");
});

test("normalizeEmail returns input when no local part", () => {
  expect(normalizeEmail("not-an-email")).toBe("not-an-email");
});
