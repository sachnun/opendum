export default defineNuxtPlugin(async () => {
  await hydrateDataCache();
});
