import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeEmail } from "./email.js";

test("normalizeEmail trims and lowercases", () => {
  assert.equal(normalizeEmail("  User@Example.COM "), "user@example.com");
});

test("normalizeEmail strips plus suffix on any domain", () => {
  assert.equal(normalizeEmail("First.Last+news@example.com"), "first.last@example.com");
  assert.equal(normalizeEmail("First.Last+news@googlemail.com"), "first.last@googlemail.com");
});

test("normalizeEmail keeps dots on every domain", () => {
  assert.equal(normalizeEmail("first.last@gmail.com"), "first.last@gmail.com");
});

test("normalizeEmail returns input when no local part", () => {
  assert.equal(normalizeEmail("not-an-email"), "not-an-email");
});
