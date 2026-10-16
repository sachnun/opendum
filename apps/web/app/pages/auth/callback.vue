<script setup lang="ts">
const { applyHandoff } = useAuth();

onMounted(() => {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = params.get("token") ?? "";
  const session = params.get("session") ?? "";
  const redirect = params.get("redirect");

  window.history.replaceState(null, "", window.location.pathname);

  if (!token || !session) {
    void navigateTo({ path: "/", query: { error: "SessionExpired" } });
    return;
  }

  applyHandoff({ access: token, session });

  const target = redirect && redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/";
  void navigateTo(target);
});
</script>

<template>
  <div class="flex h-dvh items-center justify-center bg-background font-mono text-sm text-muted-foreground">
    Signing you in...
  </div>
</template>
