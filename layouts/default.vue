<template>
  <div class="shell">
    <header v-if="auth.loggedIn" class="topbar">
      <NuxtLink class="brand" to="/tavern">Diablo Tavern</NuxtLink>
      <nav class="nav">
        <NuxtLink to="/tavern">Tavern</NuxtLink>
        <NuxtLink to="/stash">Stash</NuxtLink>
        <NuxtLink to="/caravan">Caravan</NuxtLink>
        <NuxtLink v-if="game.save?.activeExpeditions.length" to="/quests">Recover expeditions ({{ game.save.activeExpeditions.length }})</NuxtLink>
      </nav>
      <div class="row topbar-stats">
        <span class="tag">{{ game.save?.gold ?? 0 }}g</span>
        <span class="tag">Round {{ game.save?.visitRound.number ?? '—' }}</span>
        <span class="tag">{{ visitorCount }} visitors</span>
        <span class="tag">{{ stashCount }}/{{ stashCap }} stash</span>
        <button class="btn ghost" type="button" @click="logout">Logout</button>
      </div>
    </header>
    <slot />
  </div>
</template>

<script setup lang="ts">
const auth = useAuthStore()
const game = useGameStore()

const visitorCount = computed(() => game.save?.visitRound.visitors.filter((visitor) => visitor.state !== 'departed').length ?? 0)
const stashCount = computed(() => game.save?.stash.length ?? 0)
const stashCap = computed(() => game.save?.stashLimit ?? 0)

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
