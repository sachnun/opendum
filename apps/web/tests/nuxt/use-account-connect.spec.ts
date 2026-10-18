import { beforeEach, describe, expect, it, mock } from "bun:test";
import { defineComponent, h, ref } from "vue";
import { mount } from "@vue/test-utils";

import { useAccountConnect } from "~/composables/useAccountConnect";

const list = mock(async () => []);
const refreshData = mock(() => {});
const invalidateAccountCollection = mock(() => {});

(globalThis as Record<string, unknown>).useApi = () => ({ customProviders: { list } });
(globalThis as Record<string, unknown>).useInvalidate = () => ({ refreshData, invalidateAccountCollection });
(globalThis as Record<string, unknown>).useAsyncData = () => ({ data: ref([]), refresh: mock(() => {}) });
(globalThis as Record<string, unknown>).dataKeys = { customProviders: "custom-providers", playgroundOptions: "playground-options" };

type Connect = ReturnType<typeof useAccountConnect>;

const Probe = defineComponent({
  setup() {
    const connect = useAccountConnect(
      { initialProvider: null, readonly: false },
      { onConnected: mock(() => {}), onCustomCreated: mock(() => {}) }
    );
    return { connect };
  },
  render() {
    return h("div", String(this.connect.open.value));
  },
});

function mountProbe() {
  const wrapper = mount(Probe);
  return (wrapper.vm as unknown as { connect: Connect }).connect;
}

describe("useAccountConnect", () => {
  beforeEach(() => {
    mock.clearAllMocks();
  });

  it("selects a provider and advances the step", async () => {
    const connect = mountProbe();
    expect(connect.open.value).toBe(false);

    connect.selectProvider("openai");
    expect(connect.provider.value).toBe("openai");
    expect(connect.step.value).toBe(2);
  });

  it("resets when going back to the first step", async () => {
    const connect = mountProbe();
    connect.selectProvider("openai");
    connect.goBack();
    expect(connect.step.value).toBe(1);
    expect(connect.provider.value).toBe(null);
  });

  it("enters custom mode", async () => {
    const connect = mountProbe();
    connect.selectCustom();
    expect(connect.customMode.value).toBe(true);
    expect(connect.provider.value).toBe(null);
  });
});
