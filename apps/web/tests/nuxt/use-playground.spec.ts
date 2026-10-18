import { beforeEach, describe, expect, it, mock } from "bun:test";
import { defineComponent, h, ref } from "vue";
import { mount } from "@vue/test-utils";

import { usePlayground } from "~/composables/usePlayground";

const options = mock(async () => null);
const auth = mock(async () => null);

(globalThis as Record<string, unknown>).useApi = () => ({ playground: { options, auth } });
(globalThis as Record<string, unknown>).useInvalidate = () => ({ invalidateAccountCollection: mock(() => {}), invalidateAccountOverview: mock(() => {}) });
(globalThis as Record<string, unknown>).useAsyncData = () => ({ data: ref(null), error: ref(null), refresh: mock(() => {}) });
(globalThis as Record<string, unknown>).dataKeys = { playgroundOptions: "playground-options" };
(globalThis as Record<string, unknown>).useRoute = () => ({ path: "/playground", query: {} });
(globalThis as Record<string, unknown>).navigateTo = mock(() => {});

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

function mountProbe() {
  const wrapper = mount(Probe);
  return (wrapper.vm as unknown as { playground: Playground }).playground;
}

describe("usePlayground", () => {
  beforeEach(() => {
    mock.clearAllMocks();
  });

  it("starts with the first scenario and a single panel", async () => {
    const playground = mountProbe();
    expect(playground.selectedScenario.value.id).toBe("text");
    expect(playground.panels.value.length).toBe(1);
    expect(playground.settings.temperature).toBe(1);
    expect(typeof playground.runLoop).toBe("function");
  });

  it("switches the selected scenario", async () => {
    const playground = mountProbe();
    const next = playground.SCENARIOS[1]!;
    playground.selectScenario(next);
    expect(playground.selectedScenario.value.id).toBe(next.id);
  });
});
