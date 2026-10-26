import { describe, expect, it } from "bun:test";

import { ProviderRegistry } from "@opendum/providers/registry";
import type { Registry } from "@opendum/models/runtime";
import { COMPAT_SPECS } from "@opendum/providers/compat-specs";
import { API_BASE_URL as openrouterBaseUrl } from "@opendum/providers/auth/openrouter/constants";
import { API_BASE_URL as nvidiaBaseUrl } from "@opendum/providers/auth/nvidia/constants";
import { API_BASE_URL as kiloBaseUrl } from "@opendum/providers/auth/kilo-code/constants";
import { API_BASE_URL as harborBaseUrl } from "@opendum/providers/auth/harbor/constants";
import { API_BASE_URL as zenmuxBaseUrl } from "@opendum/providers/auth/zenmux/constants";
import { API_BASE_URL as hyperBaseUrl } from "@opendum/providers/auth/hyper/constants";
import { baseUrl, validationRequest } from "@opendum/providers/auth/key-settings";
import { KEY_PROVIDERS } from "@opendum/providers/provider-accounts";

const DECLARED: Record<string, string> = {
  openrouter: openrouterBaseUrl,
  nvidia_nim: nvidiaBaseUrl,
  kilo_code: kiloBaseUrl,
  harbor: harborBaseUrl,
  zenmux: zenmuxBaseUrl,
  hyper: hyperBaseUrl,
};

type CompatLike = { baseUrl?: unknown };

function baseOf(provider: unknown): string {
  return String((provider as CompatLike).baseUrl ?? "");
}

describe("provider base urls", () => {
  it("declares every compatible provider exactly once", () => {
    const names = COMPAT_SPECS.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(DECLARED[name], `unexpected spec: ${name}`).toBeDefined();
    for (const name of Object.keys(DECLARED)) expect(names).toContain(name);
  });

  it("keeps specs aligned with the provider constants", () => {
    for (const spec of COMPAT_SPECS) {
      expect(spec.baseUrl).toBe(DECLARED[spec.name]);
    }
  });

  it("routes each provider to the url declared in its spec", () => {
    const registry = new ProviderRegistry({ models: {} as Registry, fallback: null });
    for (const spec of COMPAT_SPECS) {
      const provider = registry.get(spec.name);
      expect(provider, `missing provider: ${spec.name}`).toBeDefined();
      expect(baseOf(provider)).toBe(spec.baseUrl);
    }
  });

  it("validates api keys against the same base url", () => {
    for (const provider of KEY_PROVIDERS) {
      expect(baseUrl(provider)).toBe(DECLARED[provider]);
      const request = validationRequest(provider, "key", { model: "upstream-model" });
      expect(request.url.startsWith(DECLARED[provider])).toBe(true);
    }
    const request = validationRequest("openrouter", "key", { model: "upstream-model" });
    expect(request.url).toBe(`${openrouterBaseUrl}/models`);
  });

  it("declares https base urls without trailing slash", () => {
    for (const [name, url] of Object.entries(DECLARED)) {
      expect(url.startsWith("https://"), `insecure base url for ${name}`).toBeTruthy();
      expect(url.endsWith("/"), `trailing slash for ${name}`).toBeFalsy();
    }
  });
});

describe("provider base url sources", () => {
  it("never hardcodes upstream base urls outside compat specs", async () => {
    for (const file of ["../registry.ts", "../auth/key-settings.ts"]) {
      const source = await Bun.file(`${import.meta.dir}/${file}`).text();
      expect(/baseUrl:\s*"/.test(source), `hardcoded base url in ${file}`).toBe(false);
    }
  });
});
