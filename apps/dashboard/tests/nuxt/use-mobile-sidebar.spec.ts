import { describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import { mountSuspended } from "@nuxt/test-utils/runtime";

import { useMobileSidebar } from "~/composables/useMobileSidebar";

type ProbeApi = { mobileOpen: boolean; openMobileSidebar: () => void; closeMobileSidebar: (raw?: unknown) => void };

const Probe = defineComponent({
  setup() {
    const { mobileOpen, openMobileSidebar, closeMobileSidebar } = useMobileSidebar();
    return { mobileOpen, openMobileSidebar, closeMobileSidebar };
  },
  render() {
    return h("div", String(this.mobileOpen));
  },
});

describe("useMobileSidebar", () => {
  it("opens and closes the sidebar", async () => {
    const wrapper = await mountSuspended(Probe);
    const vm = wrapper.vm as unknown as ProbeApi;
    expect(vm.mobileOpen).toBe(false);

    vm.openMobileSidebar();
    await wrapper.vm.$nextTick();
    expect(vm.mobileOpen).toBe(true);

    vm.closeMobileSidebar();
    await wrapper.vm.$nextTick();
    expect(vm.mobileOpen).toBe(false);
  });
});
