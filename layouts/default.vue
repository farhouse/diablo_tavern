<template>
  <div class="shell">
    <header v-if="auth.loggedIn" class="topbar">
      <NuxtLink class="brand" to="/juego">Diablo Tavern</NuxtLink>
      <nav class="nav">
        <NuxtLink to="/juego">Inicio</NuxtLink>
        <NuxtLink to="/visitors-v2">Visitantes</NuxtLink>
        <NuxtLink to="/equipment-v2">Equipo</NuxtLink>
        <NuxtLink to="/caravan-v2">Caravana</NuxtLink>
        <NuxtLink to="/chronicle-v2">Crónica</NuxtLink>
      </nav>
      <div class="row topbar-stats">
        <template v-if="gameV2.game">
          <span class="tag">{{ gameV2.game.resources.gold }} oro</span>
          <span class="tag">{{ gameV2.game.caravan.visitorCapacity.used }}/{{ gameV2.game.caravan.visitorCapacity.limit }} visitantes</span>
          <span class="tag">{{ gameV2.game.capacity.used }}/{{ gameV2.game.capacity.limit }} objetos</span>
        </template>
        <button class="btn ghost" type="button" @click="logout">Salir</button>
      </div>
    </header>
    <slot />
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useAuthStore } from '~/stores/auth'
import { useGameStore } from '~/stores/game'
import { useGameV2Store } from '~/stores/game-v2'
import { useChronicleV2Store } from '~/stores/chronicle-v2'

const auth = useAuthStore()
const game = useGameStore()
const gameV2 = useGameV2Store()
const chronicleV2 = useChronicleV2Store()
onMounted(() => {
  auth.hydrate()
  if (auth.loggedIn && !gameV2.game && gameV2.loadState !== 'loading') void gameV2.load()
})

function logout() {
  auth.logout()
  game.$reset()
  gameV2.$reset()
  chronicleV2.$reset()
  navigateTo('/login')
}
</script>
