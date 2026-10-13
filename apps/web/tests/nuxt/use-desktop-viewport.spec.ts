import { describe, expect, it } from "bun:test";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";

import { useDesktopViewport } from "~/composables/useDesktopViewport";

const Probe = defineComponent({
  setup() {
    const { isDesktopViewport } = useDesktopViewport();
    return { isDesktopViewport };
  },
  render() {
    return h("div", String(this.isDesktopViewport));
  },
});

describe("useDesktopViewport", () => {
  it("exposes a boolean viewport flag", async () => {
    const wrapper = mount(Probe);
    expect(["true", "false"]).toContain(wrapper.text());
  });
});
