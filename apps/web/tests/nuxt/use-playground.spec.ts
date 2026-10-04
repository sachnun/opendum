import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";

import { usePlayground } from "~/composables/usePlayground";

const mocks = vi.hoisted(() => ({ options: vi.fn(), auth: vi.fn() }));

mockNuxtImport("useApi", () => () => ({ playground: { options: mocks.options, auth: mocks.auth } }));
mockNuxtImport("useInvalidate", () => () => ({ invalidateAccountCollection: vi.fn(), refreshData: vi.fn() }));
mockNuxtImport("useCachedData", () => () => ({ data: ref(null), error: ref(null), refresh: vi.fn() }));

type Playground = ReturnType<typeof usePlayground>;

const Probe = defineComponent({
  setup() {
    const playground = usePlayground();
    return { playground };
  },
  render() {
    return h("div", String(this.playground.panels.value.length));
  },
});

async function mountProbe() {
  const wrapper = await mountSuspended(Probe);
  return (wrapper.vm as unknown as { playground: Playground }).playground;
}

describe("usePlayground", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts with the first scenario and a single panel", async () => {
    const playground = await mountProbe();
    expect(playground.selectedScenario.value.id).toBe("text");
    expect(playground.panels.value.length).toBe(1);
    expect(playground.settings.temperature).toBe(1);
    expect(typeof playground.runLoop).toBe("function");
  });

  it("switches the selected scenario", async () => {
    const playground = await mountProbe();
    const next = playground.SCENARIOS[1]!;
    playground.selectScenario(next);
    expect(playground.selectedScenario.value.id).toBe(next.id);
  });
});
