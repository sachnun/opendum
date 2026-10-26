import { beforeEach, describe, expect, it, mock } from "bun:test";
import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";

import { useAccountActions } from "~/composables/useAccountActions";

const update = mock(async () => ({ success: true, data: { id: "a1" } }));
const remove = mock(async () => ({ success: true, data: undefined }));

(globalThis as Record<string, unknown>).useApi = () => ({ accounts: { update, delete: remove } });

type Actions = ReturnType<typeof useAccountActions>;
type Handlers = {
  onActiveUpdated: ReturnType<typeof mock>;
  onTemporarilyDisabled: ReturnType<typeof mock>;
  onRenamed: ReturnType<typeof mock>;
  onDeleted: ReturnType<typeof mock>;
};

const Probe = defineComponent({
  setup() {
    const handlers: Handlers = {
      onActiveUpdated: mock(() => {}),
      onTemporarilyDisabled: mock(() => {}),
      onRenamed: mock(() => {}),
      onDeleted: mock(() => {}),
    };
    const actions = useAccountActions({ account: { id: "a1", isActive: true } as never, readonly: false }, handlers);
    return { actions, handlers };
  },
  render() {
    return h("div", String(this.actions.isToggling));
  },
});

function mountProbe() {
  const wrapper = mount(Probe);
  return wrapper.vm as unknown as { actions: Actions; handlers: Handlers };
}

describe("useAccountActions", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    update.mockImplementation(async () => ({ success: true, data: { id: "a1" } }));
    remove.mockImplementation(async () => ({ success: true, data: undefined }));
  });

  it("toggles active state and notifies the handler", async () => {
    const vm = mountProbe();

    await vm.actions.toggleActive();

    expect(update).toHaveBeenCalledWith({ id: "a1", isActive: false });
    expect(vm.handlers.onActiveUpdated).toHaveBeenCalledWith({ id: "a1" });
    expect(vm.actions.isToggling.value).toBe(false);
  });

  it("validates the temporary off duration", async () => {
    const vm = mountProbe();
    vm.actions.temporaryOffAmount.value = 0;

    await vm.actions.disableTemporarily();

    expect(update).not.toHaveBeenCalled();
    expect(vm.actions.temporaryOffError.value).toContain("at least 1");
  });

  it("deletes the account and closes via the handler", async () => {
    const vm = mountProbe();

    await vm.actions.deleteAccount();

    expect(remove).toHaveBeenCalledWith({ id: "a1" });
    expect(vm.handlers.onDeleted).toHaveBeenCalledWith("a1");
  });
});
