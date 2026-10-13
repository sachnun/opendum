import { describe, expect, it } from "bun:test";
import { mount } from "@vue/test-utils";

import UiButton from "~/components/ui/UiButton.vue";

describe("UiButton", () => {
  it("renders its slot content", async () => {
    const wrapper = mount(UiButton, { slots: { default: () => "Click" } });
    expect(wrapper.text()).toBe("Click");
    expect(wrapper.attributes("type")).toBe("button");
  });

  it("applies variant and size classes", async () => {
    const wrapper = mount(UiButton, { props: { variant: "outline", size: "lg" } });
    const classes = wrapper.classes().join(" ");
    expect(classes).toContain("border");
    expect(classes).toContain("h-10");
  });

  it("forwards the disabled state", async () => {
    const wrapper = mount(UiButton, { props: { disabled: true } });
    expect(wrapper.attributes("disabled")).toBeDefined();
  });
});
