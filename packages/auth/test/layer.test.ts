import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { AuthServiceTag, validateAPIKey } from "@opendum/auth/layer";
import type { AuthResult } from "@opendum/auth";

function result(overrides: Partial<AuthResult> = {}): AuthResult {
  return {
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
    ...overrides,
  };
}

describe("auth service layer", () => {
  it("exposes validateAPIKey through the service tag", async () => {
    const program = validateAPIKey("Bearer token").pipe(
      Effect.provideService(AuthServiceTag, {
        auth: { validateAPIKey: async () => result() } as never,
      })
    );
    const value = await Effect.runPromise(program);
    expect(value.valid).toBe(true);
    expect(value.userId).toBe("user-1");
  });

  it("propagates an invalid result without failing the program", async () => {
    const program = validateAPIKey("Bearer bad").pipe(
      Effect.provideService(AuthServiceTag, {
        auth: { validateAPIKey: async () => result({ valid: false, error: "Invalid API key" }) } as never,
      })
    );
    const value = await Effect.runPromise(program);
    expect(value.valid).toBe(false);
    expect(value.error).toBe("Invalid API key");
  });
});
