<template>
  <div class="shell">
    <header v-if="auth.loggedIn" class="topbar">
      <NuxtLink class="brand" to="/tavern">Guild Manager ARPG</NuxtLink>
      <nav class="nav">
        <NuxtLink to="/tavern">Tavern</NuxtLink>
        <NuxtLink to="/quests">Quests</NuxtLink>
        <NuxtLink to="/stash">Stash</NuxtLink>
      </nav>
      <div class="row">
        <span class="tag">{{ game.save?.gold ?? 0 }} gold</span>
        <button class="btn ghost" type="button" @click="logout">Logout</button>
      </div>
    </header>
    <slot />
  </div>
</template>

<script setup lang="ts">
const auth = useAuthStore()
const game = useGameStore()

onMounted(() => {
  auth.hydrate()
  if (auth.loggedIn && !game.save) game.load()
})

function logout() {
  auth.logout()
  game.$reset()
  navigateTo('/login')
}
</script>
