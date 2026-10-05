import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripParamInfoKey } from "#models/model/clean-key.ts";
import { buildModelIdMap } from "#models/registry/model-id.ts";

const toModelKey = (modelId: string): string => stripParamInfoKey(modelId.slice(modelId.lastIndexOf("/") + 1));

describe("buildModelIdMap", () => {
  it("lets the undated rolling id own the base key", () => {
    const map = buildModelIdMap(
      [
        "deepseek/deepseek-v4-flash",
        "deepseek/deepseek-v4-flash-0731",
        "deepseek/deepseek-v4-flash-0813",
      ],
      toModelKey
    );

    assert.deepEqual(
      [...map.entries()],
      [
        ["deepseek-v4-flash", "deepseek/deepseek-v4-flash"],
        ["deepseek-v4-flash-0731", "deepseek/deepseek-v4-flash-0731"],
        ["deepseek-v4-flash-0813", "deepseek/deepseek-v4-flash-0813"],
      ]
    );
  });

  it("lets the newest date-pinned variant own the base key without a rolling id", () => {
    const map = buildModelIdMap(["x/model-0731", "x/model-0813"], toModelKey);

    assert.equal(map.get("model"), "x/model-0813");
    assert.equal(map.get("model-0731"), "x/model-0731");
    assert.equal(map.size, 2);
  });

  it("keeps a non-trailing date token as part of the family key", () => {
    const identity = (modelId: string): string => modelId.slice(modelId.lastIndexOf("/") + 1);
    const map = buildModelIdMap(["x/model-0731-preview"], identity);
    assert.equal(map.get("model-0731-preview"), "x/model-0731-preview");
  });

  it("skips ids that normalize to an empty key", () => {
    const map = buildModelIdMap(["x/gpt-4o", "x/???"], (modelId) => (modelId.endsWith("???") ? "" : toModelKey(modelId)));
    assert.deepEqual([...map.entries()], [["gpt-4o", "x/gpt-4o"]]);
  });

  it("returns keys in sorted order", () => {
    const map = buildModelIdMap(["x/zeta", "x/alpha", "x/mid"], toModelKey);
    assert.deepEqual([...map.keys()], ["alpha", "mid", "zeta"]);
  });
});
