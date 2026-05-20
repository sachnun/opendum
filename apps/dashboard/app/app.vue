<script setup lang="ts">
import { TooltipProvider } from "reka-ui";

useHead({
  htmlAttrs: { lang: "en" },
  title: "Opendum",
  meta: [
    { name: "description", content: "Your accounts, one proxy." },
  ],
  link: [
    { rel: "icon", href: "/icon.svg", type: "image/svg+xml" },
    { rel: "shortcut icon", href: "/icon.svg", type: "image/svg+xml" },
    { rel: "apple-touch-icon", href: "/icon.svg", type: "image/svg+xml" },
  ],
});
</script>

<template>
  <TooltipProvider :delay-duration="300" :skip-delay-duration="300">
    <Suspense>
      <NuxtLayout>
        <NuxtPage />
      </NuxtLayout>
      <template #fallback>
        <div class="opendum-loading" role="status" aria-label="Loading Opendum">
          <div class="opendum-loading__brand" aria-hidden="true">
            <span class="opendum-loading__mark">
              <span class="opendum-loading__pulse" />
              <span class="opendum-loading__dot" />
            </span>
            <span class="opendum-loading__wordmark">Opendum</span>
          </div>
        </div>
      </template>
    </Suspense>
  </TooltipProvider>
</template>
