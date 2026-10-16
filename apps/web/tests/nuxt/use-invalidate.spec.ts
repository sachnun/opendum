import { describe, expect, it } from "bun:test";
import { defineComponent, h, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { registryKey } from "@effect/atom-vue";

import { useInvalidate } from "~/composables/useInvalidate";
import { registerQueryHandler, setQueryValue } from "~/utils/atom";

(globalThis as Record<string, unknown>).dataKeys = {
  shellAccounts: "web-shell-accounts",
  accountsOverview: "web-accounts-overview",
  accountsDetail: (provider: string) => `web-accounts-detail-${provider}`,
  models: "web-models",
  shellModelFamilyCounts: "web-shell-model-family-counts",
  modelSearch: "layout-model-search",
  playgroundOptions: "web-playground-options",
  apiKeys: "web-api-keys",
};

const KEY = "web-shell-accounts";

const summary = {
  accountCounts: { openai: 1 },
  activeAccountCounts: { openai: 1 },
  accountIndicators: { openai: "normal" as const },
  pinnedProviders: [] as string[],
  hasConnectedAccounts: true,
};

describe("useInvalidate", () => {
  it("patches the shared query from a handler invoked after setup", async () => {
    const registry = AtomRegistry.make();
    registerQueryHandler(registry, KEY, async () => ({ ...summary }));
    setQueryValue(registry, KEY, { ...summary });

    let invalidate: ReturnType<typeof useInvalidate> | undefined;

    const Probe = defineComponent({
      setup() {
        invalidate = useInvalidate();
        return {};
      },
      render() {
        return h("div", "probe");
      },
    });

    mount(Probe, { global: { provide: { [registryKey as never]: registry } } });
    await nextTick();

    invalidate?.patchPinnedProvider("openai", true);
    await nextTick();

    const patched = registry.get(
      (await import("~/utils/atom")).queryAtom(KEY)
    ) as { _tag: string; value: typeof summary };

    expect(patched.value.pinnedProviders).toEqual(["openai"]);
  });

  it("keeps using the provided registry rather than the default one", async () => {
    const registry = AtomRegistry.make();
    const { defaultRegistry } = await import("@effect/atom-vue");
    registerQueryHandler(registry, KEY, async () => ({ ...summary }));
    setQueryValue(registry, KEY, { ...summary });

    let invalidate: ReturnType<typeof useInvalidate> | undefined;

    const Probe = defineComponent({
      setup() {
        invalidate = useInvalidate();
        return {};
      },
      render() {
        return h("div", "probe");
      },
    });

    mount(Probe, { global: { provide: { [registryKey as never]: registry } } });
    await nextTick();

    invalidate?.patchPinnedProvider("openai", true);
    await nextTick();

    const { queryValue } = await import("~/utils/atom");
    expect(queryValue<typeof summary>(registry, KEY)?.pinnedProviders).toEqual(["openai"]);
    expect(queryValue<typeof summary>(defaultRegistry, KEY)).toBeUndefined();
  });
});
