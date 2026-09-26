<template>
  <main class="page game-home">
    <header class="game-hero card">
      <div>
        <span class="eyebrow">Tu partida</span>
        <h1>¿Qué hago ahora?</h1>
        <p class="muted">Seguí la acción recomendada. El resto de las secciones sirve para preparar o consultar la caravana.</p>
      </div>
      <button class="btn ghost" type="button" :disabled="game.loadState === 'loading'" @click="game.load">
        {{ game.loadState === 'loading' ? 'Actualizando…' : 'Actualizar partida' }}
      </button>
    </header>

    <section v-if="game.errorMessage && !game.game" class="page-alert page-alert--error" role="alert">
      <span>{{ game.errorMessage }}</span>
      <button class="btn" type="button" @click="game.load">Reintentar</button>
    </section>

    <section v-if="game.loadState === 'loading' && !game.game" class="card home-state" aria-busy="true">
      Cargando tu partida…
    </section>

    <template v-else-if="game.game">
      <section class="next-action card" aria-labelledby="next-action-title">
        <span class="step-number">Ahora</span>
        <div>
          <h2 id="next-action-title">{{ nextStep.title }}</h2>
          <p>{{ nextStep.description }}</p>
        </div>
        <NuxtLink class="btn primary" :to="nextStep.to">{{ nextStep.button }}</NuxtLink>
      </section>

      <section class="resource-grid" aria-label="Resumen de la partida">
        <article class="card resource"><span>Oro</span><strong>{{ game.game.resources.gold }}</strong></article>
        <article class="card resource"><span>Visitantes</span><strong>{{ game.game.caravan.visitorCapacity.used }} / {{ game.game.caravan.visitorCapacity.limit }}</strong></article>
        <article class="card resource"><span>Objetos</span><strong>{{ game.game.capacity.used }} / {{ game.game.capacity.limit }}</strong></article>
        <article class="card resource"><span>Manutención</span><strong>{{ game.game.caravan.maintenance.status === 'debt' ? 'Con deuda' : 'Al día' }}</strong></article>
      </section>

      <section class="card journey" aria-labelledby="journey-title">
        <div>
          <span class="eyebrow">Ciclo principal</span>
          <h2 id="journey-title">Cómo avanza una partida</h2>
        </div>
        <ol>
          <li><strong>Elegí un visitante.</strong><span>Aceptá uno de sus contratos y decidí si prestarle equipo.</span></li>
          <li><strong>Iniciá la expedición.</strong><span>El viaje avanza con el tiempo de la partida.</span></li>
          <li><strong>Resolvé el regreso.</strong><span>Actualizá los sucesos y confirmá el resultado.</span></li>
          <li><strong>Prepará la próxima salida.</strong><span>Mejorá objetos y caravana, y revisá la crónica.</span></li>
        </ol>
      </section>
    </template>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import type { ActionAvailability } from '~/shared/types/v2-game-view'
import { useGameV2Store } from '~/stores/game-v2'

const game = useGameV2Store()

function enabled(actions: readonly ActionAvailability[], action: ActionAvailability['action']) {
  return actions.some((candidate) => candidate.action === action && candidate.enabled)
}

const nextStep = computed(() => {
  const view = game.game
  if (!view) return { title: 'Cargá tu partida', description: 'Necesitamos el estado actual para recomendarte el próximo paso.', button: 'Actualizar', to: '/juego' }
  if (view.settlements.some((entry) => entry.state === 'preview_ready' && enabled(entry.actions, 'confirm_settlement'))) {
    return { title: 'Confirmá el resultado de una expedición', description: 'La recompensa está lista. Revisá las opciones y cerrá el regreso.', button: 'Ver resultado', to: '/visitors-v2' }
  }
  if (view.recoveries.some((entry) => entry.state === 'open')) {
    return { title: 'Resolvé una recuperación pendiente', description: 'Hay objetos prestados que todavía pueden recuperarse.', button: 'Ver recuperación', to: '/visitors-v2' }
  }
  if (view.visitors.some((entry) => entry.state === 'contracted' && enabled(entry.actions, 'start_expedition'))) {
    return { title: 'Iniciá la expedición contratada', description: 'El visitante ya está preparado y puede salir.', button: 'Iniciar expedición', to: '/visitors-v2' }
  }
  if (view.visitors.some((entry) => (entry.state === 'available' || entry.state === 'negotiating') && enabled(entry.actions, 'accept_contract'))) {
    return { title: 'Elegí un contrato', description: 'Tenés visitantes esperando. Elegí una propuesta para empezar el ciclo.', button: 'Ver visitantes', to: '/visitors-v2' }
  }
  if (view.expeditions.some((entry) => entry.state === 'active')) {
    return { title: 'Esperá el próximo suceso', description: 'Hay una expedición en marcha. Volvé a Visitantes para actualizarla cuando esté lista.', button: 'Ver expedición', to: '/visitors-v2' }
  }
  if (view.items.some((item) => item.actions.some((action) => action.enabled))) {
    return { title: 'Prepará tu equipo', description: 'Hay objetos con servicios disponibles antes del próximo viaje.', button: 'Ver equipo', to: '/equipment-v2' }
  }
  return { title: 'Revisá tu caravana', description: 'No hay una acción urgente. Podés preparar mejoras o consultar el historial.', button: 'Ver caravana', to: '/caravan-v2' }
})

onMounted(() => { if (!game.game) void game.load() })
</script>

<style scoped>
.game-home { display: grid; gap: 1rem; }
.game-hero, .next-action { align-items: center; display: flex; gap: 1rem; justify-content: space-between; }
.game-hero { background: linear-gradient(90deg, rgba(27,25,22,.96), rgba(27,25,22,.65)), url('/images/game/camp-modular/camp-base.png') center 62% / cover; min-height: 15rem; }
.game-hero h1, .game-hero p, .next-action h2, .next-action p, .journey h2 { margin: 0; }
.next-action { border-color: var(--accent-2); }
.next-action > div { flex: 1; min-width: 0; }
.step-number { color: var(--accent-2); font-size: .8rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.resource-grid { display: grid; gap: 1rem; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.resource { display: grid; gap: .35rem; }
.resource span { color: var(--muted); }
.resource strong { color: var(--accent-2); font-size: 1.45rem; }
.journey { display: grid; gap: 1rem; }
.journey ol { display: grid; gap: .75rem; grid-template-columns: repeat(4, minmax(0, 1fr)); list-style-position: inside; margin: 0; padding: 0; }
.journey li { display: grid; gap: .35rem; }
.journey li::marker { color: var(--accent-2); font-weight: 800; }
.journey li span { color: var(--muted); }
.home-state { min-height: 8rem; }
@media (max-width: 800px) { .resource-grid, .journey ol { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) { .game-hero, .next-action { align-items: stretch; flex-direction: column; } .resource-grid, .journey ol { grid-template-columns: 1fr; } }
</style>
