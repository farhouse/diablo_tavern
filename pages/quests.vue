<template>
  <main class="page legacy-page">
    <header class="section-title">
      <div>
        <p class="round-mark">Legacy recovery</p>
        <h1>Active expeditions</h1>
        <p class="muted">No new hero expeditions can begin. Recover parties preserved from an older save, then continue with visitor commissions.</p>
      </div>
      <NuxtLink class="btn ghost" to="/tavern#commissions">Visitor commissions</NuxtLink>
    </header>

    <p v-if="game.error" class="page-alert page-alert--error" role="alert">{{ game.error }}</p>
    <p v-if="notice" class="page-alert page-alert--success" role="status">{{ notice }}</p>
    <section v-if="game.loading && !game.save" class="card" aria-busy="true">Loading preserved expeditions…</section>
    <section v-else-if="expeditions.length" class="grid two" aria-label="Preserved active expeditions">
      <article v-for="expedition in expeditions" :key="expedition.id" class="card stack">
        <div class="row">
          <h2>{{ questName(expedition.questId) }}</h2>
          <span class="tag">{{ expedition.status }}</span>
        </div>
        <p class="muted">Depth {{ expedition.depth }} · Danger {{ expedition.danger }}%</p>
        <p>{{ expedition.carriedGold }}g · {{ expedition.carriedLoot.length }} items · {{ expedition.heroIds.length }} heroes carried</p>
        <button class="btn primary" type="button" :disabled="busyId !== ''" :aria-describedby="busyId ? `recovery-reason-${expedition.id}` : undefined" @click="recover(expedition.id, expedition.status, portalActive(expedition.portalAvailableUntil))">
          {{ busyId === expedition.id ? 'Recovering…' : expedition.status === 'returning' ? 'Process return' : portalActive(expedition.portalAvailableUntil) ? 'Use active portal' : 'Recall party' }}
        </button>
        <p v-if="busyId" :id="`recovery-reason-${expedition.id}`" class="error">{{ busyId === expedition.id ? 'This recovery is being processed.' : 'Another expedition recovery is being processed.' }}</p>
      </article>
    </section>
    <section v-else class="card stack">
      <h2>No legacy expeditions remain</h2>
      <p class="muted">The recovery route is complete. New work is assigned directly to visitors.</p>
      <NuxtLink class="btn primary" to="/tavern#commissions">Open the Tavern</NuxtLink>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useGameStore } from '~/stores/game'

const game = useGameStore()
const busyId = ref('')
const notice = ref('')
const expeditions = computed(() => game.save?.activeExpeditions ?? [])

onMounted(() => { void game.load() })

function questName(id: string): string {
  return game.quests.find((quest) => quest.id === id)?.name || id.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ')
}

function portalActive(until?: string): boolean {
  return Boolean(until && new Date(until).getTime() > Date.now())
}

async function recover(id: string, status: string, usePortal: boolean) {
  if (busyId.value) return
  busyId.value = id
  notice.value = ''
  try {
    if (status === 'returning') await game.advanceExpedition(id)
    else await game.recallExpedition(id, usePortal)
    notice.value = 'Legacy expedition recovery updated from the server.'
  } catch { /* authoritative error is rendered by the store */ } finally { busyId.value = '' }
}
</script>

<style scoped>
.legacy-page { display: grid; gap: 1rem; }
.legacy-page h1, .legacy-page h2, .legacy-page p { margin: 0; }
.legacy-page .btn { justify-content: center; }
</style>
