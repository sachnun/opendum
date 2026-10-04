import { describe, expect, it } from "vitest";
import { defineComponent, h } from "vue";
import { mountSuspended } from "@nuxt/test-utils/runtime";

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
    const wrapper = await mountSuspended(Probe);
    expect(["true", "false"]).toContain(wrapper.text());
  });
});
