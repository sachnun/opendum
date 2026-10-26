import { expect, test } from "bun:test";

import { gzip, sha256Bytes } from "@opendum/models/fs";

import {
  aaIndex,
  decodeManifest,
  normalizeSlug,
  parseLeaderboard,
  parseManifest,
  aaScore,
  stripEffort,
} from "@opendum/models/sync/aa";

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

function bufferSource(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

async function encodeManifest(models: unknown[], keyHex: string): Promise<Uint8Array> {
  const key = Uint8Array.fromHex(keyHex);
  const iv = sha256Bytes(key).subarray(0, 12);
  const cryptoKey = await crypto.subtle.importKey("raw", bufferSource(key), "AES-GCM", false, ["encrypt"]);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bufferSource(iv), tagLength: 128 },
    cryptoKey,
    bufferSource(gzip(new TextEncoder().encode(JSON.stringify(models))))
  );
  return new Uint8Array(sealed);
}

function randomHex(): string {
  return crypto.getRandomValues(new Uint8Array(32)).toHex();
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

test("normalizeSlug folds separators and drops variant suffixes", () => {
  expect(normalizeSlug("claude-opus-4.5:free")).toBe("claude-opus-4-5");
  expect(normalizeSlug("MiniMax_M3")).toBe("minimax-m3");
  expect(normalizeSlug("anthropic/claude-opus-4-5")).toBe("claude-opus-4-5");
  expect(normalizeSlug(null)).toBe("");
});

test("stripEffort removes only effort tokens", () => {
  expect(stripEffort("claude-opus-5-5-high")).toBe("claude-opus-5-5");
  expect(stripEffort("gpt-5-4-mini-medium")).toBe("gpt-5-4-mini");
  expect(stripEffort("qwen3-max")).toBe("qwen3-max");
  expect(stripEffort("kimi-k2-thinking")).toBe("kimi-k2-thinking");
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

test("parseManifest reads the encrypted payload pointer", () => {
  const key = randomHex();
  expect(parseManifest(manifestHtml("/data/abc.txt", key))).toEqual({
    path: "/data/abc.txt",
    key,
  });
  expect(parseManifest(leaderboardHtml(SAMPLE))).toBe(null);
});

test("decodeManifest decrypts the full scored list", async () => {
  const key = randomHex();
  const entries = await decodeManifest(await encodeManifest(SAMPLE, key), key);
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

test("decodeManifest fails closed on a wrong key", async () => {
  const key = randomHex();
  const other = randomHex();
  await expect(decodeManifest(await encodeManifest(SAMPLE, key), other)).rejects.toThrow();
  expect(await decodeManifest(new Uint8Array(), key)).toEqual([]);
});

test("parseLeaderboard tolerates malformed input", () => {
  expect(parseLeaderboard("<html>nothing here</html>")).toEqual([]);
  expect(parseLeaderboard(leaderboardHtml([{ slug: "", intelligenceIndex: 5 }]))).toEqual([]);
});

test("aaIndex keeps the highest score per slug", () => {
  const index = aaIndex([
    { slug: "model", name: "Model", index: 10, estimated: false },
    { slug: "model", name: "Model (max)", index: 30, estimated: false },
  ]);
  expect(index.bySlug.get("model")?.index).toBe(30);
});

test("aaScore prefers an exact slug over an effort-stripped one", () => {
  const index = aaIndex(parseLeaderboard(leaderboardHtml(SAMPLE)));
  expect(aaScore(["gpt-5-4-nano"], index)?.index).toBe(21);
  expect(aaScore(["gpt-5.4-nano"], index)?.slug).toBe("gpt-5-4-nano");
});

test("aaScore falls back to an effort-stripped slug", () => {
  const index = aaIndex(parseLeaderboard(leaderboardHtml(SAMPLE)));
  expect(aaScore(["claude-opus-5-5-medium"], index)?.slug).toBe("claude-opus-5-5");
  expect(aaScore(["MiniMax-M3"], index)?.index).toBe(29);
});

test("aaScore matches a size-qualified slug by shape", () => {
  const index = aaIndex(
    parseLeaderboard(
      leaderboardHtml([
        { slug: "nvidia-nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra", intelligenceIndex: 23 },
      ]),
    ),
  );
  expect(aaScore(["nemotron-3-ultra"], index)?.index).toBe(23);
});

test("aaScore fails closed when shapes are ambiguous across sizes", () => {
  const index = aaIndex(
    parseLeaderboard(
      leaderboardHtml([
        { slug: "gemma-3-27b-it", name: "Gemma 3 27B", intelligenceIndex: 12 },
        { slug: "gemma-3-12b-it", name: "Gemma 3 12B", intelligenceIndex: 8 },
      ]),
    ),
  );
  expect(aaScore(["gemma-3"], index)).toBe(null);
  expect(aaScore(["gemma-3-27b-it"], index)?.index).toBe(12);
});

test("aaScore never strips a tier token that doubles as an effort level", () => {
  const index = aaIndex(
    parseLeaderboard(
      leaderboardHtml([
        { slug: "mistral-medium", name: "Mistral Medium", intelligenceIndex: 5 },
        { slug: "mistral-large-3", name: "Mistral Large 3", intelligenceIndex: 9 },
      ]),
    ),
  );
  expect(aaScore(["mistral"], index)).toBe(null);
  expect(aaScore(["mistral-medium"], index)?.index).toBe(5);
});

test("aaScore rejects a shape match whose size differs", () => {
  const index = aaIndex(
    parseLeaderboard(leaderboardHtml([{ slug: "qwen2-72b-instruct", name: "Qwen2 72B", intelligenceIndex: 6 }])),
  );
  expect(aaScore(["qwen2-7b-instruct"], index)).toBe(null);
  expect(aaScore(["qwen2-72b-instruct"], index)?.index).toBe(6);
});

test("aaScore matches reordered tokens of the same shape", () => {
  const index = aaIndex(
    parseLeaderboard(leaderboardHtml([{ slug: "claude-4-5-haiku", name: "Claude 4.5 Haiku", intelligenceIndex: 17 }])),
  );
  expect(aaScore(["claude-haiku-4-5"], index)?.index).toBe(17);
});

test("aaScore scans every probe before giving up", () => {
  const index = aaIndex(parseLeaderboard(leaderboardHtml(SAMPLE)));
  expect(aaScore(["unrelated", "", "glm-4.5v"], index)?.slug).toBe("glm-4-5v");
  expect(aaScore(["unrelated"], index)).toBe(null);
  expect(aaScore([], index)).toBe(null);
});
