import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { defineComponent, h } from "vue";
import { mockNuxtImport, mountSuspended } from "@nuxt/test-utils/runtime";

import { useProviderAccountActions } from "~/composables/useProviderAccountActions";

const mocks = vi.hoisted(() => ({ update: vi.fn(), delete: vi.fn() }));

mockNuxtImport("useApi", () => () => ({ accounts: { update: mocks.update, delete: mocks.delete } }));

type Actions = ReturnType<typeof useProviderAccountActions>;
type Handlers = {
  onActiveUpdated: Mock;
  onTemporarilyDisabled: Mock;
  onRenamed: Mock;
  onDeleted: Mock;
};

const Probe = defineComponent({
  setup() {
    const handlers: Handlers = {
      onActiveUpdated: vi.fn(),
      onTemporarilyDisabled: vi.fn(),
      onRenamed: vi.fn(),
      onDeleted: vi.fn(),
    };
    const actions = useProviderAccountActions({ account: { id: "a1", isActive: true } as never, readonly: false }, handlers);
    return { actions, handlers };
  },
  render() {
    return h("div", String(this.actions.isToggling));
  },
});

async function mountProbe() {
  const wrapper = await mountSuspended(Probe);
  return wrapper.vm as unknown as { actions: Actions; handlers: Handlers };
}

describe("useProviderAccountActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("toggles active state and notifies the handler", async () => {
    mocks.update.mockResolvedValue({ success: true, data: { id: "a1" } });
    const vm = await mountProbe();

    await vm.actions.toggleActive();

    expect(mocks.update).toHaveBeenCalledWith({ id: "a1", isActive: false });
    expect(vm.handlers.onActiveUpdated).toHaveBeenCalledWith({ id: "a1" });
    expect(vm.actions.isToggling.value).toBe(false);
  });

  it("validates the temporary off duration", async () => {
    const vm = await mountProbe();
    vm.actions.temporaryOffAmount.value = 0;

    await vm.actions.disableTemporarily();

    expect(mocks.update).not.toHaveBeenCalled();
    expect(vm.actions.temporaryOffError.value).toContain("at least 1");
  });

  it("deletes the account and closes via the handler", async () => {
    mocks.delete.mockResolvedValue({ success: true, data: undefined });
    const vm = await mountProbe();

    await vm.actions.deleteAccount();

    expect(mocks.delete).toHaveBeenCalledWith({ id: "a1" });
    expect(vm.handlers.onDeleted).toHaveBeenCalledWith("a1");
  });
});
