import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ANALYTICS_VERSION_BUMP_PREFIX,
  ANALYTICS_VERSION_PREFIX,
  API_KEY_LAST_USED_PREFIX,
  API_KEY_VALIDATION_PREFIX,
  REFRESH_FAIL_COUNT_PREFIX,
  SESSION_AFFINITY_PREFIX,
  USER_DISABLED_MODELS_PREFIX,
  analyticsVersionBumpKey,
  analyticsVersionKey,
  apiKeyLastUsedKey,
  apiKeyValidationKey,
  disabledModelsKey,
  refreshFailCountKey,
  sessionAffinityKey,
} from "#redis/keys.ts";

describe("redis key builders", () => {
  it("builds api key keys", () => {
    assert.equal(apiKeyValidationKey("abc"), `${API_KEY_VALIDATION_PREFIX}:abc`);
    assert.equal(apiKeyLastUsedKey("key-1"), `${API_KEY_LAST_USED_PREFIX}:key-1`);
  });

  it("builds user and account keys", () => {
    assert.equal(disabledModelsKey("user-1"), `${USER_DISABLED_MODELS_PREFIX}:user-1`);
    assert.equal(refreshFailCountKey("acct-1"), `${REFRESH_FAIL_COUNT_PREFIX}:acct-1`);
  });

  it("builds session and analytics keys", () => {
    assert.equal(sessionAffinityKey("user-1", "sess-1"), `${SESSION_AFFINITY_PREFIX}:user-1:sess-1`);
    assert.equal(analyticsVersionKey("user-1"), `${ANALYTICS_VERSION_PREFIX}:user-1`);
    assert.equal(analyticsVersionBumpKey("user-1"), `${ANALYTICS_VERSION_BUMP_PREFIX}:user-1`);
  });
});
