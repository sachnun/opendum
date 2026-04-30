<script setup lang="ts">
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
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
