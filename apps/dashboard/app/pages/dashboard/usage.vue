<script setup lang="ts">
definePageMeta({ middleware: "auth", layout: "dashboard" });

const config = useRuntimeConfig();
const baseUrl = computed(() => {
  const proxyUrl = String(config.public.proxyUrl || "").replace(/\/$/, "");
  return proxyUrl ? `${proxyUrl}/v1` : "http://localhost:4000/v1";
});

const copiedValue = ref<string | null>(null);
let copyTimeout: ReturnType<typeof setTimeout> | null = null;

async function copyInlineCode(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    copiedValue.value = value;

    if (copyTimeout) {
      clearTimeout(copyTimeout);
    }

    copyTimeout = setTimeout(() => {
      copiedValue.value = null;
    }, 1800);
  } catch {
    console.error("Failed to copy to clipboard");
  }
}

onBeforeUnmount(() => {
  if (copyTimeout) {
    clearTimeout(copyTimeout);
  }
});
</script>

<template>
  <div class="space-y-6">
    <DashboardPageHeader title="Usage" />

    <UiCard class="bg-card">
      <UiCardHeader>
        <UiCardTitle>Start in 3 steps</UiCardTitle>
      </UiCardHeader>
      <UiCardContent class="space-y-4">
        <ol class="space-y-3 text-sm">
          <li class="flex gap-3">
            <span class="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium">1</span>
            <span>
              Create an API key from
              <NuxtLink to="/dashboard/api-keys" class="font-medium text-primary underline-offset-4 hover:underline">
                /dashboard/api-keys
              </NuxtLink>
              .
            </span>
          </li>
          <li class="flex gap-3">
            <span class="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium">2</span>
            <span>
              Set
              <code class="inline-flex items-center gap-1 break-all rounded bg-muted px-1 py-0.5 text-xs">
                {{ baseUrl }}
                <button
                  type="button"
                  class="inline-flex shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                  :aria-label="copiedValue === baseUrl ? 'Copied' : 'Copy to clipboard'"
                  @click="copyInlineCode(baseUrl)"
                >
                  <UiIcon :name="copiedValue === baseUrl ? 'i-lucide-check' : 'i-lucide-copy'" class="size-3" />
                </button>
              </code>
              as your API base URL.
            </span>
          </li>
          <li class="flex gap-3">
            <span class="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium">3</span>
            <span>
              Send your key as <code class="rounded bg-muted px-1 py-0.5 text-xs">Bearer</code>
              for OpenAI-compatible requests or <code class="rounded bg-muted px-1 py-0.5 text-xs">x-api-key</code>
              for Anthropic-compatible requests.
            </span>
          </li>
        </ol>
      </UiCardContent>
    </UiCard>

    <UiCard class="bg-card">
      <UiCardHeader>
        <UiCardTitle>Compatibility reference</UiCardTitle>
      </UiCardHeader>
      <UiCardContent class="grid gap-4 md:grid-cols-3">
        <div class="min-w-0 space-y-3 rounded-lg border border-border bg-muted/30 p-4">
          <UiBadge variant="outline">OpenAI-compatible</UiBadge>
          <div>
            <p class="text-xs text-muted-foreground">Endpoint</p>
            <code class="break-all text-sm">POST {{ baseUrl }}/chat/completions</code>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">Auth header</p>
            <code class="break-all text-sm">Authorization: Bearer &lt;api_key&gt;</code>
          </div>
        </div>

        <div class="min-w-0 space-y-3 rounded-lg border border-border bg-muted/30 p-4">
          <UiBadge variant="outline">Anthropic</UiBadge>
          <div>
            <p class="text-xs text-muted-foreground">Endpoint</p>
            <code class="break-all text-sm">POST {{ baseUrl }}/messages</code>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">Auth headers</p>
            <div class="space-y-1">
              <code class="block break-all text-sm">x-api-key: &lt;api_key&gt;</code>
              <code class="block break-all text-sm">anthropic-version: 2023-06-01</code>
            </div>
          </div>
        </div>

        <div class="min-w-0 space-y-3 rounded-lg border border-border bg-muted/30 p-4">
          <UiBadge variant="outline">OpenAI Responses</UiBadge>
          <div>
            <p class="text-xs text-muted-foreground">Endpoint</p>
            <code class="break-all text-sm">POST {{ baseUrl }}/responses</code>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">Auth header</p>
            <code class="break-all text-sm">Authorization: Bearer &lt;api_key&gt;</code>
          </div>
        </div>
      </UiCardContent>
    </UiCard>
  </div>
</template>
