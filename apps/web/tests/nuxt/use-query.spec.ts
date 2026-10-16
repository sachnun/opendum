import { describe, expect, it, mock } from "bun:test";
import { defineComponent, h, nextTick, ref } from "vue";
import { mount } from "@vue/test-utils";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { registryKey } from "@effect/atom-vue";

import { useQuery } from "~/composables/useQuery";
import { invalidateQueries, patchQueryValue, queryValue } from "~/utils/atom";

function mountProbe(registry: AtomRegistry.AtomRegistry, key: string, handler: () => Promise<unknown>) {
  const Probe = defineComponent({
    setup() {
      const query = useQuery<unknown>(key, handler);
      return { query };
    },
    render() {
      return h("div", JSON.stringify(this.query.data.value ?? null));
    },
  });

  return mount(Probe, { global: { provide: { [registryKey as never]: registry } } });
}

async function flush(ms = 40) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await nextTick();
}

describe("useQuery", () => {
  it("loads once on mount without double fetching", async () => {
    const registry = AtomRegistry.make();
    const handler = mock(async () => ({ n: 1 }));

    const wrapper = mountProbe(registry, "probe-once", handler);
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toBe('{"n":1}');
  });

  it("refetches when the key is invalidated", async () => {
    const registry = AtomRegistry.make();
    let calls = 0;
    const wrapper = mountProbe(registry, "probe-invalidate", async () => ({ n: ++calls }));
    await flush();
    expect(wrapper.text()).toBe('{"n":1}');

    invalidateQueries(registry, "probe-invalidate");
    await flush();

    expect(wrapper.text()).toBe('{"n":2}');
  });

  it("fetches when the key was invalidated before mount", async () => {
    const registry = AtomRegistry.make();
    invalidateQueries(registry, "probe-late");
    await flush();

    const handler = mock(async () => ({ n: 7 }));
    const wrapper = mountProbe(registry, "probe-late", handler);
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toBe('{"n":7}');
  });

  it("keeps an optimistic patch until the next refresh", async () => {
    const registry = AtomRegistry.make();
    const wrapper = mountProbe(registry, "probe-patch", async () => ({ n: 1 }));
    await flush();

    patchQueryValue<{ n: number }>(registry, "probe-patch", () => ({ n: 99 }));
    await nextTick();
    expect(wrapper.text()).toBe('{"n":99}');

    await (wrapper.vm as unknown as { query: { refresh: () => Promise<void> } }).query.refresh();
    await flush();
    expect(wrapper.text()).toBe('{"n":1}');
  });

  it("tracks the value written through the setter", async () => {
    const registry = AtomRegistry.make();
    const wrapper = mountProbe(registry, "probe-set", async () => ({ n: 1 }));
    await flush();

    (wrapper.vm as unknown as { query: { set: (value: unknown) => void } }).query.set({ n: 5 });
    await nextTick();

    expect(wrapper.text()).toBe('{"n":5}');
    expect(queryValue<{ n: number }>(registry, "probe-set")?.n).toBe(5);
  });

  it("reloads when a reactive key changes", async () => {
    const registry = AtomRegistry.make();
    const key = ref("probe-key-a");
    const handler = mock(async () => ({ n: 1 }));

    const Probe = defineComponent({
      setup() {
        const query = useQuery<unknown>(() => key.value, handler);
        return { query };
      },
      render() {
        return h("div", JSON.stringify(this.query.data.value ?? null));
      },
    });

    const wrapper = mount(Probe, { global: { provide: { [registryKey as never]: registry } } });
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);

    key.value = "probe-key-b";
    await flush();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toBe('{"n":1}');
  });
});
