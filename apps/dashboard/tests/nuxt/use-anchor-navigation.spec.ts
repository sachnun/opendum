import { describe, expect, it } from "vitest";
import { defineComponent, h, ref } from "vue";
import { mountSuspended } from "@nuxt/test-utils/runtime";

import { useAnchorNavigation } from "~/composables/useAnchorNavigation";

type ProbeApi = { activeAnchorId: string | null; handleNavClick: (item?: unknown, event?: MouseEvent) => void; scrollToAnchor: (id: string) => boolean };

const Probe = defineComponent({
  setup() {
    const anchorIds = ref<string[]>([]);
    const { activeAnchorId, handleNavClick, scrollToAnchor } = useAnchorNavigation({ anchorIds });
    return { activeAnchorId, handleNavClick, scrollToAnchor };
  },
  render() {
    return h("div", String(this.activeAnchorId ?? "none"));
  },
});

describe("useAnchorNavigation", () => {
  it("starts without an active anchor and ignores missing sections", async () => {
    const wrapper = await mountSuspended(Probe);
    const vm = wrapper.vm as unknown as ProbeApi;
    expect(vm.activeAnchorId).toBe(null);
    expect(typeof vm.handleNavClick).toBe("function");
    expect(vm.scrollToAnchor("does-not-exist")).toBe(false);
    expect(vm.activeAnchorId).toBe(null);
  });
});
