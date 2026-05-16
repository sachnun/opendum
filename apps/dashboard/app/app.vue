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
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </TooltipProvider>
</template>
