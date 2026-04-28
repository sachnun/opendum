<script setup lang="ts">
definePageMeta({ middleware: "auth", layout: "dashboard" });

const config = useRuntimeConfig();
const { $client } = useNuxtApp();
const prompt = ref("Say hello in one sentence.");
const model = ref("");
const apiKey = ref("");
const response = ref("");
const loading = ref(false);

type ModelListItem = Awaited<ReturnType<typeof $client.models.list.query>>[number];
type ApiKeyListItem = Awaited<ReturnType<typeof $client.apiKeys.list.query>>[number];

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

async function loadOptions() {
  const result: { models: ModelListItem[]; apiKeys: ApiKeyListItem[] } = { models: [], apiKeys: [] };
  try {
    result.models = await $client.models.list.query();
  } catch (error) {
    console.warn("Failed to load playground models:", error);
  }
  try {
    result.apiKeys = await $client.apiKeys.list.query();
  } catch (error) {
    console.warn("Failed to load playground API keys:", error);
  }
  return result;
}

const { data } = await useAsyncData("dashboard-playground-options", loadOptions);
const modelItems = computed(() => (data.value?.models ?? []).map((item) => item.id));
const apiKeyItems = computed(() => (data.value?.apiKeys ?? []).map((item) => ({ label: item.name ?? item.keyPreview, value: item.id })));

watchEffect(() => {
  if (!model.value && modelItems.value[0]) model.value = modelItems.value[0];
  if (!apiKey.value && apiKeyItems.value[0]) apiKey.value = apiKeyItems.value[0].value;
});

async function runPrompt() {
  loading.value = true;
  response.value = "";
  try {
    const proxyUrl = String(config.public.proxyUrl || "").replace(/\/$/, "");
    if (!proxyUrl || !apiKey.value) {
      response.value = "Configure a proxy URL and select an API key to send a live request.";
      return;
    }
    const revealedKey = await $client.apiKeys.reveal.query({ id: apiKey.value });
    if (!revealedKey.success) {
      response.value = revealedKey.error;
      return;
    }

    const result = await $fetch<ChatCompletionResponse>(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${revealedKey.data.key}` },
      body: {
        model: model.value,
        messages: [{ role: "user", content: prompt.value }],
      },
    });
    response.value = result?.choices?.[0]?.message?.content ?? JSON.stringify(result, null, 2);
  } catch (error) {
    response.value = error instanceof Error ? error.message : "Request failed";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="space-y-6">
    <DashboardPageHeader title="Playground" description="A lightweight chat completion tester for the Nuxt dashboard." />

    <div class="grid gap-4 lg:grid-cols-[360px_1fr]">
      <UCard>
        <div class="space-y-4">
          <UFormField label="Model">
            <USelect v-model="model" :items="modelItems" placeholder="Select model" class="w-full" />
          </UFormField>
          <UFormField label="API key">
            <USelect v-model="apiKey" :items="apiKeyItems" placeholder="Select key" class="w-full" />
          </UFormField>
          <UButton :loading="loading" icon="i-lucide-send" block @click="runPrompt">
            Run prompt
          </UButton>
        </div>
      </UCard>

      <UCard>
        <div class="space-y-4">
          <UFormField label="Prompt">
            <UTextarea v-model="prompt" :rows="8" class="w-full" />
          </UFormField>
          <div class="rounded-lg border border-border bg-muted/20 p-4">
            <p class="mb-2 text-sm font-medium">Response</p>
            <pre class="min-h-40 whitespace-pre-wrap text-sm text-muted-foreground">{{ response || 'Run a prompt to see a response.' }}</pre>
          </div>
        </div>
      </UCard>
    </div>
  </div>
</template>
