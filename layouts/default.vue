<template>
  <div class="shell">
    <header v-if="auth.loggedIn" class="topbar">
      <NuxtLink class="brand" to="/tavern">Diablo Tavern</NuxtLink>
      <nav class="nav">
        <NuxtLink to="/tavern">Tavern</NuxtLink>
        <NuxtLink to="/visitors-v2">Visitantes V2</NuxtLink>
        <NuxtLink to="/equipment-v2">Equipo V2</NuxtLink>
        <NuxtLink to="/caravan-v2">Caravana V2</NuxtLink>
        <NuxtLink to="/chronicle-v2">Crónica V2</NuxtLink>
        <NuxtLink to="/stash">Stash</NuxtLink>
        <NuxtLink to="/caravan">Caravan</NuxtLink>
      </nav>
      <div class="row topbar-stats">
        <template v-if="!isVisitorsV2">
          <span class="tag">{{ game.save?.gold ?? 0 }}g</span>
          <span class="tag">Round {{ game.save?.visitRound.number ?? '—' }}</span>
          <span class="tag">{{ visitorCount }} visitors</span>
          <span class="tag">{{ stashCount }}/{{ stashCap }} stash</span>
        </template>
        <button class="btn ghost" type="button" @click="logout">Logout</button>
      </div>
    </header>
    <slot />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useAuthStore } from '~/stores/auth'
import { useGameStore } from '~/stores/game'
import { useGameV2Store } from '~/stores/game-v2'

const auth = useAuthStore()
const game = useGameStore()
const gameV2 = useGameV2Store()
const route = useRoute()
const isVisitorsV2 = computed(() => route.path.endsWith('-v2'))

const visitorCount = computed(() => game.save?.visitRound.slots.filter((slot) => Boolean(slot.visitor)).length ?? 0)
const stashCount = computed(() => game.save?.stash.length ?? 0)
const stashCap = computed(() => game.save?.stashLimit ?? 0)

function loadLegacyGame() {
  if (!isVisitorsV2.value && auth.loggedIn && !game.save && !game.loading) void game.load()
}

watch(() => route.path, loadLegacyGame)

onMounted(() => {
  auth.hydrate()
  loadLegacyGame()
})

function logout() {
  auth.logout()
  game.$reset()
  gameV2.$reset()
  navigateTo('/login')
}
</script>
