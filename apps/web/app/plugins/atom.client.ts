import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { registryKey } from "@effect/atom-vue";

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.provide(registryKey, AtomRegistry.make());
});
