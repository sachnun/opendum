import { expect, test } from "bun:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
  buildAaIndex,
  decodeLeaderboardManifest,
  normalizeAaSlug,
  parseLeaderboard,
  parseLeaderboardManifest,
  resolveAaScore,
  stripEffortSuffix,
} from "./aa.ts";

function leaderboardHtml(models: unknown[], key = "models"): string {
  const inner = `{"${key}":${JSON.stringify(models)}}`;
  const escaped = inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `<html><script>self.__next_f.push([1,"${escaped}"])</script></html>`;
}

function manifestHtml(path: string, key: string): string {
  const inner = `{"manifest":{"path":"${path}","key":"${key}"}}`;
  const escaped = inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `<html><script>self.__next_f.push([1,"${escaped}"])</script></html>`;
}

function encodeManifest(models: unknown[], keyHex: string): Uint8Array {
  const key = Buffer.from(keyHex, "hex");
  const iv = createHash("sha256").update(key).digest().subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(models)))), cipher.final()]);
  return new Uint8Array(Buffer.concat([body, cipher.getAuthTag()]));
}

const SAMPLE = [
  { slug: "claude-opus-5-5", name: "Claude Opus 5.5 (Max)", intelligenceIndex: 58, intelligenceIndexIsEstimated: false },
  { slug: "claude-opus-5-5-xhigh", name: "Claude Opus 5.5 (Xhigh)", intelligenceIndex: 56 },
  { slug: "gpt-5-4-nano-medium", name: "GPT-5.4 nano (Medium)", intelligenceIndex: 20 },
  { slug: "gpt-5-4-nano", name: "GPT-5.4 nano (Xhigh)", intelligenceIndex: 21 },
  { slug: "MiniMax-M3", name: "MiniMax M3", intelligenceIndex: 29, intelligenceIndexIsEstimated: true },
  { slug: "glm-4-5v", name: "GLM-4.5V (Non-reasoning)", intelligenceIndex: 6.696, intelligenceIndexIsEstimated: true },
  { slug: "unscored-model", name: "No score" },
];

test("normalizeAaSlug folds separators and drops variant suffixes", () => {
  expect(normalizeAaSlug("claude-opus-4.5:free")).toBe("claude-opus-4-5");
  expect(normalizeAaSlug("MiniMax_M3")).toBe("minimax-m3");
  expect(normalizeAaSlug("anthropic/claude-opus-4-5")).toBe("claude-opus-4-5");
  expect(normalizeAaSlug(null)).toBe("");
});

test("stripEffortSuffix removes only effort tokens", () => {
  expect(stripEffortSuffix("claude-opus-5-5-high")).toBe("claude-opus-5-5");
  expect(stripEffortSuffix("gpt-5-4-mini-medium")).toBe("gpt-5-4-mini");
  expect(stripEffortSuffix("qwen3-max")).toBe("qwen3-max");
  expect(stripEffortSuffix("kimi-k2-thinking")).toBe("kimi-k2-thinking");
});

test("parseLeaderboard extracts scored models", () => {
  const models = parseLeaderboard(leaderboardHtml(SAMPLE));
  expect(models.length).toBe(6);
  expect(models[0]).toEqual({
    slug: "claude-opus-5-5",
    name: "Claude Opus 5.5 (Max)",
    index: 58,
    estimated: false,
  });
  expect(models.find((model) => model.slug === "MiniMax-M3")?.estimated).toBe(true);
});

test("parseLeaderboard accepts renamed model list keys", () => {
  expect(parseLeaderboard(leaderboardHtml(SAMPLE, "initialModels"))).toHaveLength(6);
  expect(parseLeaderboard(leaderboardHtml(SAMPLE, "scoredModels"))).toHaveLength(6);
});

test("parseLeaderboardManifest reads the encrypted payload pointer", () => {
  const key = randomBytes(32).toString("hex");
  expect(parseLeaderboardManifest(manifestHtml("/data/abc.txt", key))).toEqual({
    path: "/data/abc.txt",
    key,
  });
  expect(parseLeaderboardManifest(leaderboardHtml(SAMPLE))).toBe(null);
});

test("decodeLeaderboardManifest decrypts the full scored list", () => {
  const key = randomBytes(32).toString("hex");
  const entries = decodeLeaderboardManifest(encodeManifest(SAMPLE, key), key);
  expect(entries.map((entry) => entry.slug)).toEqual([
    "claude-opus-5-5",
    "claude-opus-5-5-xhigh",
    "gpt-5-4-nano-medium",
    "gpt-5-4-nano",
    "MiniMax-M3",
    "glm-4-5v",
  ]);
  expect(entries[4]?.estimated).toBe(true);
});

test("decodeLeaderboardManifest fails closed on a wrong key", () => {
  const key = randomBytes(32).toString("hex");
  const other = randomBytes(32).toString("hex");
  expect(() => decodeLeaderboardManifest(encodeManifest(SAMPLE, key), other)).toThrow();
  expect(decodeLeaderboardManifest(new Uint8Array(), key)).toEqual([]);
});

test("parseLeaderboard tolerates malformed input", () => {
  expect(parseLeaderboard("<html>nothing here</html>")).toEqual([]);
  expect(parseLeaderboard(leaderboardHtml([{ slug: "", intelligenceIndex: 5 }]))).toEqual([]);
});

test("buildAaIndex keeps the highest score per slug", () => {
  const index = buildAaIndex([
    { slug: "model", name: "Model", index: 10, estimated: false },
    { slug: "model", name: "Model (max)", index: 30, estimated: false },
  ]);
  expect(index.bySlug.get("model")?.index).toBe(30);
});

test("resolveAaScore prefers an exact slug over an effort-stripped one", () => {
  const index = buildAaIndex(parseLeaderboard(leaderboardHtml(SAMPLE)));
  expect(resolveAaScore(["gpt-5-4-nano"], index)?.index).toBe(21);
  expect(resolveAaScore(["gpt-5.4-nano"], index)?.slug).toBe("gpt-5-4-nano");
});

test("resolveAaScore falls back to an effort-stripped slug", () => {
  const index = buildAaIndex(parseLeaderboard(leaderboardHtml(SAMPLE)));
  expect(resolveAaScore(["claude-opus-5-5-medium"], index)?.slug).toBe("claude-opus-5-5");
  expect(resolveAaScore(["MiniMax-M3"], index)?.index).toBe(29);
});

test("resolveAaScore matches a size-qualified slug by shape", () => {
  const index = buildAaIndex(
    parseLeaderboard(
      leaderboardHtml([
        { slug: "nvidia-nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra", intelligenceIndex: 23 },
      ]),
    ),
  );
  expect(resolveAaScore(["nemotron-3-ultra"], index)?.index).toBe(23);
});

test("resolveAaScore fails closed when shapes are ambiguous across sizes", () => {
  const index = buildAaIndex(
    parseLeaderboard(
      leaderboardHtml([
        { slug: "gemma-3-27b-it", name: "Gemma 3 27B", intelligenceIndex: 12 },
        { slug: "gemma-3-12b-it", name: "Gemma 3 12B", intelligenceIndex: 8 },
      ]),
    ),
  );
  expect(resolveAaScore(["gemma-3"], index)).toBe(null);
  expect(resolveAaScore(["gemma-3-27b-it"], index)?.index).toBe(12);
});

test("resolveAaScore never strips a tier token that doubles as an effort level", () => {
  const index = buildAaIndex(
    parseLeaderboard(
      leaderboardHtml([
        { slug: "mistral-medium", name: "Mistral Medium", intelligenceIndex: 5 },
        { slug: "mistral-large-3", name: "Mistral Large 3", intelligenceIndex: 9 },
      ]),
    ),
  );
  expect(resolveAaScore(["mistral"], index)).toBe(null);
  expect(resolveAaScore(["mistral-medium"], index)?.index).toBe(5);
});

test("resolveAaScore rejects a shape match whose size differs", () => {
  const index = buildAaIndex(
    parseLeaderboard(leaderboardHtml([{ slug: "qwen2-72b-instruct", name: "Qwen2 72B", intelligenceIndex: 6 }])),
  );
  expect(resolveAaScore(["qwen2-7b-instruct"], index)).toBe(null);
  expect(resolveAaScore(["qwen2-72b-instruct"], index)?.index).toBe(6);
});

test("resolveAaScore matches reordered tokens of the same shape", () => {
  const index = buildAaIndex(
    parseLeaderboard(leaderboardHtml([{ slug: "claude-4-5-haiku", name: "Claude 4.5 Haiku", intelligenceIndex: 17 }])),
  );
  expect(resolveAaScore(["claude-haiku-4-5"], index)?.index).toBe(17);
});

test("resolveAaScore scans every probe before giving up", () => {
  const index = buildAaIndex(parseLeaderboard(leaderboardHtml(SAMPLE)));
  expect(resolveAaScore(["unrelated", "", "glm-4.5v"], index)?.slug).toBe("glm-4-5v");
  expect(resolveAaScore(["unrelated"], index)).toBe(null);
  expect(resolveAaScore([], index)).toBe(null);
});
