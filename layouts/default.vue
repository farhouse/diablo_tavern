<template>
  <div class="shell">
    <header v-if="auth.loggedIn" class="topbar">
      <NuxtLink class="brand" to="/tavern">Guild Manager ARPG</NuxtLink>
      <nav class="nav">
        <NuxtLink to="/tavern">Tavern</NuxtLink>
        <NuxtLink to="/quests">Quests</NuxtLink>
        <NuxtLink to="/stash">Stash</NuxtLink>
        <NuxtLink to="/caravan">Caravan</NuxtLink>
      </nav>
      <div class="row topbar-stats">
        <span class="tag">{{ game.save?.gold ?? 0 }}g</span>
        <span class="tag material">{{ game.save?.materials ?? 0 }}m</span>
        <span class="tag">{{ activeHeroCount }}/{{ heroCap }} heroes</span>
        <span class="tag">{{ expeditionCount }}/{{ expeditionCap }} exp.</span>
        <span class="tag">{{ stashCount }}/{{ stashCap }} stash</span>
        <button class="btn ghost" type="button" @click="logout">Logout</button>
      </div>
    </header>
    <slot />
  </div>
</template>

<script setup lang="ts">
import { getHeroCapacity, getExpeditionCapacity, getStashCapacity, getActiveHeroCount } from '~/utils/game-logic'

const auth = useAuthStore()
const game = useGameStore()

const activeHeroCount = computed(() => game.save ? getActiveHeroCount(game.save) : 0)
const heroCap = computed(() => game.save ? getHeroCapacity(game.save) : 0)
const expeditionCount = computed(() => game.save?.activeExpeditions.length ?? 0)
const expeditionCap = computed(() => game.save ? getExpeditionCapacity(game.save) : 0)
const stashCount = computed(() => game.save?.stash.length ?? 0)
const stashCap = computed(() => game.save ? getStashCapacity(game.save) : 0)

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
