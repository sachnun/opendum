import { describe, expect, it } from "vitest";
import { mountSuspended } from "@nuxt/test-utils/runtime";

import UiButton from "~/components/ui/UiButton.vue";

describe("UiButton", () => {
  it("renders its slot content", async () => {
    const wrapper = await mountSuspended(UiButton, { slots: { default: () => "Click" } });
    expect(wrapper.text()).toBe("Click");
    expect(wrapper.attributes("type")).toBe("button");
  });

  it("applies variant and size classes", async () => {
    const wrapper = await mountSuspended(UiButton, { props: { variant: "outline", size: "lg" } });
    const classes = wrapper.classes().join(" ");
    expect(classes).toContain("border");
    expect(classes).toContain("h-10");
  });

  it("forwards the disabled state", async () => {
    const wrapper = await mountSuspended(UiButton, { props: { disabled: true } });
    expect(wrapper.attributes("disabled")).toBeDefined();
  });
});
