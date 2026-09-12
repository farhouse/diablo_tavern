<template>
  <main class="page stash-page">
    <header class="section-title">
      <div>
        <h1>Stash</h1>
        <p class="muted">Keep stock for future visitors. {{ stashUsed }} / {{ stashCap }} slots used.</p>
      </div>
      <button class="btn ghost" type="button" :disabled="game.loading" @click="reload">
        {{ game.loading ? 'Refreshing…' : 'Refresh' }}
      </button>
    </header>

    <div v-if="game.error" class="page-alert page-alert--error" role="alert">
      <span>{{ game.error }}</span>
      <button class="btn" type="button" @click="reload">Try again</button>
    </div>
    <p v-if="notice" class="page-alert page-alert--success" role="status">{{ notice }}</p>
    <section v-if="game.loading && !game.save" class="grid three" aria-busy="true" aria-label="Loading stash">
      <div v-for="index in 3" :key="index" class="card stash-skeleton" />
    </section>

    <section v-else-if="game.save?.stash.length" class="grid three" aria-label="Stored items">
      <article v-for="item in game.save.stash" :key="item.id" class="card item stack" :class="item.rarity">
        <div class="row">
          <h2>{{ itemName(item) }}</h2>
          <span class="tag">{{ item.rarity }}</span>
        </div>
        <p class="muted">{{ item.type }} · level {{ item.requiredLevel }} · {{ item.value }}g reference value</p>
        <div v-if="item.identified" class="stack affix-list">
          <span v-for="affix in item.affixes" :key="`${item.id}-${affix.stat}`">+{{ affix.value }} {{ affix.stat }}</span>
          <span v-if="!item.affixes.length" class="muted">No additional affixes.</span>
        </div>
        <div v-else class="stack">
          <p class="muted">Visitors will not quote unidentified goods.</p>
          <div class="item-actions">
            <button class="btn" type="button" :disabled="Boolean(identifyDisabledReason(item))" :aria-describedby="identifyDisabledReason(item) ? `identify-reason-${item.id}` : undefined" @click="identify(item.id)">
              {{ busyItem === item.id ? 'Identifying…' : `Identify${identifyCost(item.rarity) ? ` for ${identifyCost(item.rarity)}g` : ''}` }}
            </button>
            <p v-if="identifyDisabledReason(item)" :id="`identify-reason-${item.id}`" class="error">{{ identifyDisabledReason(item) }}</p>
            <button
              v-if="hasAppraiser"
              class="btn ghost"
              type="button"
              :disabled="Boolean(appraiseDisabledReason(item.id))"
              :aria-describedby="appraiseDisabledReason(item.id) ? `appraise-reason-${item.id}` : undefined"
              @click="queueAppraise(item.id)"
            >
              {{ isInQueue(item.id) ? 'In Appraiser queue' : 'Send to Appraiser' }}
            </button>
            <p v-if="appraiseDisabledReason(item.id)" :id="`appraise-reason-${item.id}`" class="error">{{ appraiseDisabledReason(item.id) }}</p>
          </div>
        </div>
        <details class="salvage-details">
          <summary>Emergency salvage</summary>
          <p class="muted">Destroys this item for {{ salvageValue(item) }}g — only 25% of reference value. A visitor may offer more.</p>
          <button class="btn ghost" type="button" :disabled="Boolean(salvageDisabledReason(item.id))" :aria-describedby="salvageDisabledReason(item.id) ? `salvage-reason-${item.id}` : undefined" @click="salvage(item)">
            {{ busyItem === item.id ? 'Salvaging…' : `Salvage for ${salvageValue(item)}g` }}
          </button>
          <p v-if="salvageDisabledReason(item.id)" :id="`salvage-reason-${item.id}`" class="error">{{ salvageDisabledReason(item.id) }}</p>
        </details>
      </article>
    </section>

    <section v-else class="card empty-stash">
      <h2>The stash is empty</h2>
      <p class="muted">Buy an offer from a visitor in the Tavern to stock your shelves.</p>
      <NuxtLink class="btn primary" to="/tavern">Return to Tavern</NuxtLink>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useGameStore } from '~/stores/game'
import type { Item } from '~/types/game'
import { getAppraiserQueueSize, identifyCost } from '~/utils/game-logic'

const game = useGameStore()
const busyItem = ref('')
const notice = ref('')
const stashCap = computed(() => game.save?.stashLimit ?? 0)
const stashUsed = computed(() => game.save?.stash.length ?? 0)
const hasAppraiser = computed(() => (game.save?.caravan.upgrades.appraiser ?? 0) >= 1)
const appraiserQueue = computed(() => game.save?.caravan.services.appraiserQueue ?? [])
const isQueueFull = computed(() => appraiserQueue.value.length >= (game.save ? getAppraiserQueueSize(game.save) : 0))

onMounted(() => { void reload() })

async function reload() {
  notice.value = ''
  try { await game.load() } catch { /* recoverable error is rendered */ }
}

function isInQueue(itemId: string) {
  return appraiserQueue.value.some((job) => job.itemId === itemId)
}

function itemName(item: Item): string {
  return item.identified ? item.displayName : `Unidentified ${capitalize(item.rarity)} ${item.baseName}`
}

function identifyDisabledReason(item: Item): string {
  if (busyItem.value) return busyItem.value === item.id ? 'Identification is being processed.' : 'Another stash action is being processed.'
  if (isInQueue(item.id)) return 'This item is already in the Appraiser queue.'
  const shortfall = identifyCost(item.rarity) - (game.save?.gold ?? 0)
  return shortfall > 0 ? `Need ${shortfall}g more.` : ''
}

function appraiseDisabledReason(itemId: string): string {
  if (busyItem.value) return busyItem.value === itemId ? 'Appraiser request is being processed.' : 'Another stash action is being processed.'
  if (isInQueue(itemId)) return 'This item is already in the Appraiser queue.'
  if (isQueueFull.value) return 'The Appraiser queue is full.'
  return ''
}

function salvageDisabledReason(itemId: string): string {
  if (busyItem.value) return busyItem.value === itemId ? 'Salvage is being processed.' : 'Another stash action is being processed.'
  if (isInQueue(itemId)) return 'The Appraiser is currently handling this item.'
  return ''
}

function salvageValue(item: Item): number {
  return Math.max(1, Math.floor(item.value * 0.25))
}

async function identify(itemId: string) {
  await perform(itemId, 'Item identified.', () => game.identify(itemId))
}

async function queueAppraise(itemId: string) {
  await perform(itemId, 'Item added to the Appraiser queue.', () => game.startAppraisal(itemId))
}

async function salvage(item: Item) {
  await perform(item.id, `${itemName(item)} salvaged for ${salvageValue(item)}g.`, () => game.salvage(item.id))
}

async function perform(itemId: string, message: string, action: () => Promise<void>) {
  if (busyItem.value) return
  busyItem.value = itemId
  notice.value = ''
  try {
    await action()
    notice.value = message
  } catch {
    // The server response remains authoritative and the error stays visible.
  } finally {
    busyItem.value = ''
  }
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}
</script>

<style scoped>
.stash-page { display: grid; gap: 1rem; }
.stash-page h2, .stash-page p { margin: 0; }
.item { border-color: var(--rarity-color, var(--line)); }
.item.magic { --rarity-color: #5b8dee; }
.item.rare { --rarity-color: #d8a849; }
.item.unique { --rarity-color: #b87333; }
.affix-list { color: var(--ok); }
.item-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.salvage-details { border-top: 1px solid var(--line); padding-top: 0.75rem; }
.salvage-details summary { color: var(--muted); cursor: pointer; }
.salvage-details p { margin: 0.6rem 0; }
.empty-stash { align-items: start; display: grid; gap: 0.65rem; justify-items: start; }
.stash-skeleton { animation: pulse 1.5s ease-in-out infinite; min-height: 14rem; }
@media (prefers-reduced-motion: reduce) { .stash-skeleton { animation: none; } }
</style>
