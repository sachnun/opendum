import { describe, expect, it } from "bun:test";
import { defineComponent, h, ref } from "vue";
import { mount } from "@vue/test-utils";

import { useAnchorNavigation } from "~/composables/useAnchorNavigation";

type ProbeApi = { activeAnchorId: string | null; handleNavClick: (item?: unknown, event?: MouseEvent) => void; scrollToAnchor: (id: string) => boolean };

(globalThis as Record<string, unknown>).useRoute = () => ({ path: "/", query: {} });

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
    const wrapper = mount(Probe);
    const vm = wrapper.vm as unknown as ProbeApi;
    expect(vm.activeAnchorId).toBe(null);
    expect(typeof vm.handleNavClick).toBe("function");
    expect(vm.scrollToAnchor("does-not-exist")).toBe(false);
    expect(vm.activeAnchorId).toBe(null);
  });
});
