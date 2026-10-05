import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "@opendum/models/runtime";
import { openAICompatibleExtension } from "#providers/providers/openai-compatible-extension.ts";
import { OpenAICompatibleProvider } from "#providers/providers/openai-compatible.ts";
import { createTransport } from "#providers/api/http.ts";

describe("openAICompatibleExtension", () => {
  it("creates providers from config", () => {
    const extension = openAICompatibleExtension({
      name: "custom",
      baseUrl: "https://api",
      fallbackBaseUrl: "https://fallback",
      supportedParams: new Set(["model", "messages"]),
      trimPrefix: "custom/",
    });
    assert.equal(extension.name, "custom");
    const provider = extension.create({
      registry: {} as Registry,
      transport: createTransport(async () => new Response("{}")),
      fallback: null,
      redis: null,
    });
    assert.ok(provider instanceof OpenAICompatibleProvider);
    assert.equal(provider.name, "custom");
  });
});
