import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildAaIndex,
  normalizeAaSlug,
  parseLeaderboard,
  resolveAaScore,
  stripEffortSuffix,
} from "./aa.ts";

function leaderboardHtml(models: unknown[], version = "4.3"): string {
  const inner = `{"models":${JSON.stringify(models)}}`;
  const escaped = inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `<html><script>self.__next_f.push([1,"${escaped}"])</script>Intelligence Index v${version}</html>`;
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
  assert.equal(normalizeAaSlug("claude-opus-4.5:free"), "claude-opus-4-5");
  assert.equal(normalizeAaSlug("MiniMax_M3"), "minimax-m3");
  assert.equal(normalizeAaSlug("anthropic/claude-opus-4-5"), "claude-opus-4-5");
  assert.equal(normalizeAaSlug(null), "");
});

test("stripEffortSuffix removes only effort tokens", () => {
  assert.equal(stripEffortSuffix("claude-opus-5-5-high"), "claude-opus-5-5");
  assert.equal(stripEffortSuffix("gpt-5-4-mini-medium"), "gpt-5-4-mini");
  assert.equal(stripEffortSuffix("qwen3-max"), "qwen3-max");
  assert.equal(stripEffortSuffix("kimi-k2-thinking"), "kimi-k2-thinking");
});

test("parseLeaderboard extracts scored models and the index version", () => {
  const { version, models } = parseLeaderboard(leaderboardHtml(SAMPLE, "4.3"));
  assert.equal(version, "4.3");
  assert.equal(models.length, 6);
  assert.deepEqual(models[0], {
    slug: "claude-opus-5-5",
    name: "Claude Opus 5.5 (Max)",
    index: 58,
    estimated: false,
  });
  assert.equal(models.find((model) => model.slug === "MiniMax-M3")?.estimated, true);
});

test("parseLeaderboard tolerates malformed input", () => {
  assert.deepEqual(parseLeaderboard("<html>nothing here</html>").models, []);
  assert.equal(parseLeaderboard("<html>nothing here</html>").version, "");
  assert.deepEqual(parseLeaderboard(leaderboardHtml([{ slug: "", intelligenceIndex: 5 }])).models, []);
});

test("buildAaIndex keeps the highest score per slug", () => {
  const index = buildAaIndex(
    [
      { slug: "model", name: "Model", index: 10, estimated: false },
      { slug: "model", name: "Model (max)", index: 30, estimated: false },
    ],
    "4.3",
  );
  assert.equal(index.bySlug.get("model")?.index, 30);
});

test("resolveAaScore prefers an exact slug over an effort-stripped one", () => {
  const { models, version } = parseLeaderboard(leaderboardHtml(SAMPLE));
  const index = buildAaIndex(models, version);
  assert.equal(resolveAaScore(["gpt-5-4-nano"], index)?.index, 21);
  assert.equal(resolveAaScore(["gpt-5.4-nano"], index)?.slug, "gpt-5-4-nano");
});

test("resolveAaScore falls back to an effort-stripped slug", () => {
  const { models, version } = parseLeaderboard(leaderboardHtml(SAMPLE));
  const index = buildAaIndex(models, version);
  assert.equal(resolveAaScore(["claude-opus-5-5-medium"], index)?.slug, "claude-opus-5-5");
  assert.equal(resolveAaScore(["MiniMax-M3"], index)?.index, 29);
});

test("resolveAaScore matches a size-qualified slug by shape", () => {
  const { models, version } = parseLeaderboard(
    leaderboardHtml([
      { slug: "nvidia-nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra", intelligenceIndex: 23 },
    ]),
  );
  const index = buildAaIndex(models, version);
  assert.equal(resolveAaScore(["nemotron-3-ultra"], index)?.index, 23);
});

test("resolveAaScore fails closed when shapes are ambiguous across sizes", () => {
  const { models, version } = parseLeaderboard(
    leaderboardHtml([
      { slug: "gemma-3-27b-it", name: "Gemma 3 27B", intelligenceIndex: 12 },
      { slug: "gemma-3-12b-it", name: "Gemma 3 12B", intelligenceIndex: 8 },
    ]),
  );
  const index = buildAaIndex(models, version);
  assert.equal(resolveAaScore(["gemma-3"], index), null);
  assert.equal(resolveAaScore(["gemma-3-27b-it"], index)?.index, 12);
});

test("resolveAaScore never strips a tier token that doubles as an effort level", () => {
  const { models, version } = parseLeaderboard(
    leaderboardHtml([
      { slug: "mistral-medium", name: "Mistral Medium", intelligenceIndex: 5 },
      { slug: "mistral-large-3", name: "Mistral Large 3", intelligenceIndex: 9 },
    ]),
  );
  const index = buildAaIndex(models, version);
  assert.equal(resolveAaScore(["mistral"], index), null);
  assert.equal(resolveAaScore(["mistral-medium"], index)?.index, 5);
});

test("resolveAaScore rejects a shape match whose size differs", () => {
  const { models, version } = parseLeaderboard(
    leaderboardHtml([{ slug: "qwen2-72b-instruct", name: "Qwen2 72B", intelligenceIndex: 6 }]),
  );
  const index = buildAaIndex(models, version);
  assert.equal(resolveAaScore(["qwen2-7b-instruct"], index), null);
  assert.equal(resolveAaScore(["qwen2-72b-instruct"], index)?.index, 6);
});

test("resolveAaScore matches reordered tokens of the same shape", () => {
  const { models, version } = parseLeaderboard(
    leaderboardHtml([{ slug: "claude-4-5-haiku", name: "Claude 4.5 Haiku", intelligenceIndex: 17 }]),
  );
  const index = buildAaIndex(models, version);
  assert.equal(resolveAaScore(["claude-haiku-4-5"], index)?.index, 17);
});

test("resolveAaScore scans every probe before giving up", () => {
  const { models, version } = parseLeaderboard(leaderboardHtml(SAMPLE));
  const index = buildAaIndex(models, version);
  assert.equal(resolveAaScore(["unrelated", "", "glm-4.5v"], index)?.slug, "glm-4-5v");
  assert.equal(resolveAaScore(["unrelated"], index), null);
  assert.equal(resolveAaScore([], index), null);
});
