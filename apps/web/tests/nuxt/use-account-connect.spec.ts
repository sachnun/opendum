import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";

import { useAccountConnect } from "~/composables/useAccountConnect";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

mockNuxtImport("useApi", () => () => ({ customProviders: { list: mocks.list } }));
mockNuxtImport("useInvalidate", () => () => ({ refreshData: vi.fn(), invalidateAccountCollection: vi.fn() }));
mockNuxtImport("useCachedData", () => () => ({ data: ref([]), refresh: vi.fn() }));

type Connect = ReturnType<typeof useAccountConnect>;

const Probe = defineComponent({
  setup() {
    const connect = useAccountConnect(
      { initialProvider: null, readonly: false },
      { onConnected: vi.fn(), onCustomCreated: vi.fn() }
    );
    return { connect };
  },
  render() {
    return h("div", String(this.connect.open.value));
  },
});

async function mountProbe() {
  const wrapper = await mountSuspended(Probe);
  return (wrapper.vm as unknown as { connect: Connect }).connect;
}

describe("useAccountConnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects a provider and advances the step", async () => {
    const connect = await mountProbe();
    expect(connect.open.value).toBe(false);

    connect.selectProvider("openai");
    expect(connect.provider.value).toBe("openai");
    expect(connect.step.value).toBe(2);
  });

  it("resets when going back to the first step", async () => {
    const connect = await mountProbe();
    connect.selectProvider("openai");
    connect.goBack();
    expect(connect.step.value).toBe(1);
    expect(connect.provider.value).toBe(null);
  });

  it("enters custom mode", async () => {
    const connect = await mountProbe();
    connect.selectCustom();
    expect(connect.customMode.value).toBe(true);
    expect(connect.provider.value).toBe(null);
  });
});
