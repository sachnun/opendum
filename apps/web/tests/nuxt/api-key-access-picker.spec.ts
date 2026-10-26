import { describe, expect, it } from "bun:test";
import { defineComponent, h, ref } from "vue";
import { mount } from "@vue/test-utils";

import Picker from "~/components/api-key/ApiKeyAccessPicker.vue";

const targets = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta" },
];

const Harness = defineComponent({
  components: { Picker },
  setup() {
    const mode = ref<"all" | "whitelist" | "blacklist">("all");
    const ids = ref<string[]>([]);
    const search = ref("");
    const pickerOpen = ref(false);
    const saving = ref(false);
    const error = ref("");
    const saved = ref({ mode: "all" as const, ids: [] as string[] });
    const savedPayload = ref<{ mode: string; ids: string[] } | null>(null);
    return { mode, ids, search, pickerOpen, saving, error, saved, savedPayload, targets };
  },
  render() {
    return h(Picker, {
      mode: this.mode,
      "onUpdate:mode": (value: string) => (this.mode = value as never),
      ids: this.ids,
      "onUpdate:ids": (value: string[]) => (this.ids = value),
      search: this.search,
      "onUpdate:search": (value: string) => (this.search = value),
      pickerOpen: this.pickerOpen,
      "onUpdate:pickerOpen": (value: boolean) => (this.pickerOpen = value),
      saving: this.saving,
      "onUpdate:saving": (value: boolean) => (this.saving = value),
      error: this.error,
      "onUpdate:error": (value: string) => (this.error = value),
      saved: this.saved,
      "onUpdate:saved": (value: { mode: string; ids: string[] }) => (this.saved = value as never),
      title: "Models",
      noun: "model",
      targets: this.targets,
      searchText: (target: { label: string }) => target.label,
      initialMode: "all",
      initialIds: [],
      normalize: (values: string[]) => [...new Set(values)].sort(),
      onSave: (value: { mode: string; ids: string[] }) => (this.savedPayload = value),
    });
  },
});

const stubs = {
  UiButton: { template: "<button v-bind=\"$attrs\"><slot /></button>" },
  UiIcon: { template: "<span />" },
  UiBadge: { template: "<span><slot /></span>" },
  UiTooltip: { template: "<span><slot /></span>" },
  UiPopover: {
    props: ["open"],
    emits: ["update:open"],
    template: "<div><slot /><slot name=\"content\" /></div>",
  },
};

function mountHarness() {
  return mount(Harness, { global: { stubs } });
}

describe("ApiKeyAccessPicker", () => {
  it("switches modes and toggles targets", async () => {
    const wrapper = mountHarness();
    const buttons = wrapper.findAll("button");
    await buttons[1]?.trigger("click");
    expect(wrapper.vm.mode).toBe("whitelist");

    const target = wrapper.findAll("button").find((button) => button.text().includes("Alpha"));
    await target?.trigger("click");
    expect(wrapper.vm.ids).toEqual(["a"]);
  });

  it("blocks saving an empty whitelist", async () => {
    const wrapper = mountHarness();
    await wrapper.findAll("button")[1]?.trigger("click");
    const save = wrapper.findAll("button").find((button) => button.text() === "Save");
    await save?.trigger("click");
    expect(wrapper.vm.savedPayload).toBeNull();
    expect(wrapper.vm.error).toBe("Select at least one model");
  });

  it("emits the selected payload when saving", async () => {
    const wrapper = mountHarness();
    await wrapper.findAll("button")[1]?.trigger("click");
    const target = wrapper.findAll("button").find((button) => button.text().includes("Beta"));
    await target?.trigger("click");
    const save = wrapper.findAll("button").find((button) => button.text() === "Save");
    await save?.trigger("click");
    expect(wrapper.vm.savedPayload).toEqual({ mode: "whitelist", ids: ["b"] });
  });
});
