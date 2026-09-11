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
    <p v-if="notice" class="page-alert" :class="`page-alert--${noticeTone}`" role="status">{{ notice }}</p>
    <section v-if="game.loading && !game.save" class="card" aria-busy="true">Loading preserved expeditions…</section>
    <section v-else-if="expeditions.length" class="grid two" aria-label="Preserved active expeditions">
      <article v-for="expedition in expeditions" :key="expedition.id" class="card stack">
        <div class="row">
          <h2>{{ questName(expedition.questId) }}</h2>
          <span class="tag">{{ expedition.status }}</span>
        </div>
        <p class="muted">Depth {{ expedition.depth }} · Danger {{ expedition.danger }}%</p>
        <p>{{ expedition.carriedGold }}g · {{ expedition.carriedLoot.length }} items · {{ expedition.heroIds.length }} heroes carried</p>
        <p v-if="expedition.status === 'returning'" class="muted" data-testid="return-eta">
          {{ returnEta(expedition.returnsAt) }}
        </p>
        <button
          class="btn primary"
          type="button"
          :disabled="Boolean(recoveryDisabledReason(expedition))"
          :aria-describedby="recoveryDisabledReason(expedition) ? `recovery-reason-${expedition.id}` : undefined"
          @click="recover(expedition)"
        >
          {{ busyId === expedition.id ? 'Recovering…' : expedition.status === 'returning' ? 'Process return' : portalActive(expedition.portalAvailableUntil) ? 'Use active portal' : 'Recall party' }}
        </button>
        <p v-if="recoveryDisabledReason(expedition)" :id="`recovery-reason-${expedition.id}`" class="error">
          {{ recoveryDisabledReason(expedition) }}
        </p>
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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useGameStore } from '~/stores/game'
import type { ActiveExpedition } from '~/types/game'

const game = useGameStore()
const busyId = ref('')
const notice = ref('')
const noticeTone = ref<'success' | 'info'>('success')
const now = ref(Date.now())
const expeditions = computed(() => game.save?.activeExpeditions ?? [])
let timer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  void game.load()
  timer = setInterval(() => { now.value = Date.now() }, 1000)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

function questName(id: string): string {
  return game.quests.find((quest) => quest.id === id)?.name || id.split('-').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ')
}

function portalActive(until?: string): boolean {
  const timestamp = until ? new Date(until).getTime() : Number.NaN
  return Number.isFinite(timestamp) && timestamp > now.value
}

function returnReady(returnsAt?: string): boolean {
  const timestamp = returnTimestamp(returnsAt)
  return timestamp !== undefined && timestamp <= now.value
}

function returnEta(returnsAt?: string): string {
  const timestamp = returnTimestamp(returnsAt)
  if (timestamp === undefined) return 'Return time is unavailable. Refresh before processing.'
  const remaining = Math.max(0, timestamp - now.value)
  if (remaining === 0) return 'Ready to process.'
  const seconds = Math.ceil(remaining / 1000)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `Returns in ${minutes ? `${minutes}m${rest ? ` ${rest}s` : ''}` : `${rest}s`}.`
}

function recoveryDisabledReason(expedition: ActiveExpedition): string {
  if (busyId.value) return busyId.value === expedition.id
    ? 'This recovery is being processed.'
    : 'Another expedition recovery is being processed.'
  if (expedition.status === 'returning' && !returnReady(expedition.returnsAt)) {
    const timestamp = returnTimestamp(expedition.returnsAt)
    return timestamp !== undefined
      ? `Wait until ${new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.`
      : 'Refresh to obtain the persisted return time.'
  }
  return ''
}

async function recover(expedition: ActiveExpedition) {
  if (busyId.value) return
  if (expedition.status === 'returning' && !returnReady(expedition.returnsAt)) return
  busyId.value = expedition.id
  notice.value = ''
  try {
    if (expedition.status === 'returning') await game.advanceExpedition(expedition.id)
    else await game.recallExpedition(expedition.id, portalActive(expedition.portalAvailableUntil))

    const persisted = game.save?.activeExpeditions.find((entry) => entry.id === expedition.id)
    if (!persisted || persisted.status !== expedition.status) {
      noticeTone.value = 'success'
      notice.value = persisted
        ? 'Legacy expedition recall started. Its return time is persisted.'
        : 'Legacy expedition returned and its recovered resources are persisted.'
    } else {
      noticeTone.value = 'info'
      notice.value = 'The server has not completed this return yet. Retry is safe.'
    }
  } catch {
    const mutationError = game.error
    await game.load()
    const persisted = game.save?.activeExpeditions.find((entry) => entry.id === expedition.id)
    const recallPersisted = expedition.status !== 'returning'
      && persisted?.status === 'returning'
      && returnTimestamp(persisted.returnsAt) !== undefined
    if (!persisted || recallPersisted) {
      game.error = ''
      noticeTone.value = 'success'
      notice.value = persisted
        ? 'Legacy expedition recall started. Its return time is persisted.'
        : 'Legacy expedition returned and its recovered resources are persisted.'
    } else if (!game.error) {
      game.error = mutationError
    }
  } finally { busyId.value = '' }
}

function returnTimestamp(value?: string): number | undefined {
  if (!value) return undefined
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : undefined
}
</script>

<style scoped>
.legacy-page { display: grid; gap: 1rem; }
.legacy-page h1, .legacy-page h2, .legacy-page p { margin: 0; }
.legacy-page .btn { justify-content: center; }
.page-alert--info { background: var(--panel); border: 1px solid var(--line); }
</style>
