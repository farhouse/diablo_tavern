<template>
  <main class="page caravan-page">
    <header class="section-title">
      <div>
        <h1>Caravan</h1>
        <p class="muted">Support the trading floor with more storage and patient appraisal.</p>
      </div>
    </header>

    <p v-if="game.error" class="page-alert page-alert--error" role="alert">{{ game.error }}</p>
    <p v-if="notice" class="page-alert page-alert--success" role="status">{{ notice }}</p>

    <section class="caravan-status" aria-label="Caravan capacity">
      <div><strong>2</strong><span>visitor posts</span></div>
      <div><strong>{{ stashCap }}</strong><span>stash slots</span></div>
      <div><strong>{{ appraiserLevel }}</strong><span>appraisal slots</span></div>
    </section>

    <section class="service-list" aria-label="Caravan services">
      <article class="service-row">
        <div>
          <h2>Visitor posts</h2>
          <p class="muted">Two travelers are served per round. Wagons now represent the floor capacity, not a hero roster.</p>
        </div>
        <span class="tag">2 active</span>
      </article>

      <article v-for="service in services" :key="service.id" class="service-row">
        <div>
          <h2>{{ service.label }}</h2>
          <p class="muted">{{ service.description }}</p>
          <p>{{ serviceStatus(service.id) }}</p>
        </div>
        <div class="service-action">
          <template v-if="canUpgrade(service.id)">
            <span>{{ upgradeCost(service.id)?.gold }}g</span>
            <button
              class="btn primary"
              type="button"
              :disabled="!canAfford(service.id) || upgrading !== ''"
              @click="upgrade(service.id)"
            >
              {{ upgrading === service.id ? 'Upgrading…' : 'Upgrade' }}
            </button>
            <small v-if="!canAfford(service.id)" class="error">Not enough gold.</small>
          </template>
          <span v-else class="tag ok">Max level</span>
        </div>
      </article>
    </section>

    <section v-if="appraiserLevel > 0" class="appraiser-panel">
      <div>
        <h2>Appraiser queue</h2>
        <p class="muted">{{ appraiserQueue.length }} / {{ appraiserLevel }} slots used. Identification preserves trade value.</p>
      </div>
      <div class="queue-list">
        <div v-for="job in appraiserQueue" :key="job.id" class="queue-row">
          <span>{{ itemNameById(job.itemId) }}</span>
          <span class="tag">{{ timeRemaining(job.finishesAt) }}</span>
        </div>
        <p v-if="!appraiserQueue.length" class="muted">The queue is empty. Send an unidentified item from Stash.</p>
      </div>
      <button class="btn" type="button" :disabled="processing" @click="completeAppraisal">
        {{ processing ? 'Checking…' : 'Process ready items' }}
      </button>
    </section>

    <aside class="paused-systems">
      <strong>Outside this MVP</strong>
      <p>Materials and the Infirmary remain preserved in old saves, but they are not part of the visitor trade flow.</p>
    </aside>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useGameStore } from '~/stores/game'
import type { CaravanUpgradeId } from '~/types/game'
import { getMaxUpgradeLevel, getStashCapacity, getUpgradeCost } from '~/utils/game-logic'

type ActiveService = Extract<CaravanUpgradeId, 'stashWagon' | 'appraiser'>
const game = useGameStore()
const upgrading = ref<ActiveService | ''>('')
const processing = ref(false)
const notice = ref('')
const services: Array<{ id: ActiveService; label: string; description: string }> = [
  { id: 'stashWagon', label: 'Stash wagon', description: 'Hold more merchandise between visitor rounds.' },
  { id: 'appraiser', label: 'Appraiser', description: 'Identify goods over time without paying an instant fee.' }
]
const appraiserLevel = computed(() => game.save?.caravan.upgrades.appraiser ?? 0)
const appraiserQueue = computed(() => game.save?.caravan.services.appraiserQueue ?? [])
const stashCap = computed(() => game.save ? getStashCapacity(game.save) : 0)

onMounted(() => { void game.load() })

function currentLevel(id: ActiveService) { return game.save?.caravan.upgrades[id] ?? 0 }
function upgradeCost(id: ActiveService) { return getUpgradeCost(id, currentLevel(id)) }
function canUpgrade(id: ActiveService) { return currentLevel(id) < getMaxUpgradeLevel(id) }
function canAfford(id: ActiveService) {
  const cost = upgradeCost(id)
  return Boolean(cost && game.save && game.save.gold >= cost.gold)
}
function serviceStatus(id: ActiveService) {
  const level = currentLevel(id)
  if (id === 'stashWagon') return `Level ${level} · ${[20, 30, 45, 60][level]} slots`
  return level ? `Level ${level} · ${level} queue slot${level === 1 ? '' : 's'}` : 'Level 0 · Appraiser unavailable'
}
function itemNameById(itemId: string): string {
  const item = game.save?.stash.find((entry) => entry.id === itemId)
  return item?.displayName || 'Unknown item'
}
function timeRemaining(finishesAt: string): string {
  const remaining = new Date(finishesAt).getTime() - Date.now()
  return remaining <= 0 ? 'Ready' : `${Math.ceil(remaining / 60000)} min`
}
async function upgrade(id: ActiveService) {
  if (upgrading.value) return
  upgrading.value = id
  notice.value = ''
  try {
    await game.upgradeCaravan(id)
    notice.value = `${services.find((service) => service.id === id)?.label} upgraded.`
  } catch { /* server error is rendered */ } finally { upgrading.value = '' }
}
async function completeAppraisal() {
  if (processing.value) return
  processing.value = true
  notice.value = ''
  try {
    await game.completeAppraisal()
    notice.value = 'Ready appraisal work processed.'
  } catch { /* server error is rendered */ } finally { processing.value = false }
}
</script>

<style scoped>
.caravan-page { display: grid; gap: 1.25rem; }
.caravan-status { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; display: flex; flex-wrap: wrap; }
.caravan-status > div { display: grid; gap: 0.1rem; min-width: 9rem; padding: 1rem 1.25rem; }
.caravan-status > div + div { border-left: 1px solid var(--line); }
.caravan-status strong { color: var(--accent-2); font-size: 1.4rem; }
.caravan-status span { color: var(--muted); font-size: 0.85rem; }
.service-list { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.service-row { align-items: center; background: var(--panel); display: flex; gap: 1rem; justify-content: space-between; padding: 1rem; }
.service-row + .service-row { border-top: 1px solid var(--line); }
.service-row h2, .service-row p, .appraiser-panel h2, .appraiser-panel p, .paused-systems p { margin: 0; }
.service-row > div:first-child { display: grid; gap: 0.3rem; }
.service-action { align-items: end; display: grid; gap: 0.35rem; justify-items: end; }
.appraiser-panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; display: grid; gap: 0.85rem; padding: 1rem; }
.queue-list { display: grid; gap: 0.5rem; }
.queue-row { align-items: center; background: #14120f; border-radius: 6px; display: flex; justify-content: space-between; padding: 0.65rem; }
.paused-systems { border-top: 1px solid var(--line); color: var(--muted); padding-top: 1rem; }
.paused-systems strong { color: var(--text); }
@media (max-width: 600px) {
  .caravan-status { display: grid; grid-template-columns: repeat(3, 1fr); }
  .caravan-status > div { min-width: 0; padding: 0.8rem; }
  .service-row { align-items: stretch; flex-direction: column; }
  .service-action { justify-items: stretch; }
  .service-action .btn { justify-content: center; }
}
</style>
