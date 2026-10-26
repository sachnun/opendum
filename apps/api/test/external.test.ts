import { describe, expect, it } from "bun:test";

import { fetchExternal } from "@opendum/api/web/lib/external";

describe("external fetch", () => {
  it("rejects non https targets", async () => {
    await expect(fetchExternal("http://example.com/token")).rejects.toThrow("https");
  });

  it("rejects targets with credentials", async () => {
    await expect(fetchExternal("https://user:pass@example.com/token")).rejects.toThrow("https");
  });

  it("rejects private network targets", async () => {
    await expect(fetchExternal("https://127.0.0.1/token")).rejects.toThrow("private");
  });

  it("rejects unsupported methods", async () => {
    await expect(fetchExternal("https://example.com/token", { method: "TRACE" })).rejects.toThrow("unsupported");
  });

  it("rejects invalid urls", async () => {
    await expect(fetchExternal("not-a-url")).rejects.toThrow("invalid");
  });
});
