import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const startTokenRefresher = vi.fn(async () => undefined);
  return {
    loadEnv: vi.fn(() => ({ NODE_ENV: "production", DATABASE_URL: "postgres://db", REDIS_URL: "redis://cache", BETTER_AUTH_SECRET: "secret" })),
    loadEnvFile: vi.fn(),
    serve: vi.fn(() => ({ close: vi.fn(async () => undefined) })),
    startTokenRefresher,
    createContext: vi.fn(async () => ({ service: { startTokenRefresher } })),
    disposeContext: vi.fn(async () => undefined),
    createServer: vi.fn(() => ({})),
  };
});

vi.mock("@opendum/config", () => ({ loadEnv: mocks.loadEnv, loadEnvFile: mocks.loadEnvFile }));
vi.mock("h3", () => ({ serve: mocks.serve }));
vi.mock("../src/context.js", () => ({ createContext: mocks.createContext, disposeContext: mocks.disposeContext }));
vi.mock("../src/server.js", () => ({ createServer: mocks.createServer }));

describe("main", () => {
  it("boots the server and shuts down on signals", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await import("../src/main.js");
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(mocks.loadEnvFile.mock.calls.length, 2);
    assert.equal(mocks.serve.mock.calls.length, 1);
    assert.deepEqual((mocks.serve.mock.calls[0] as unknown[])[1], { hostname: "0.0.0.0", port: 8000 });
    assert.equal(mocks.createServer.mock.calls.length, 1);
    assert.equal(mocks.startTokenRefresher.mock.calls.length, 1);
    assert.equal(log.mock.calls.length >= 1, true);

    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(mocks.disposeContext.mock.calls.length, 1);
    assert.equal(exit.mock.calls.length >= 1, true);

    process.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(mocks.disposeContext.mock.calls.length, 1);

    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  });
});
