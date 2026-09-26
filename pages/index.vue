<template>
  <main class="page">
    <p class="muted">Loading...</p>
  </main>
</template>

<script setup lang="ts">
const auth = useAuthStore()
auth.hydrate()
await navigateTo(auth.loggedIn ? '/juego' : '/login')
</script>
