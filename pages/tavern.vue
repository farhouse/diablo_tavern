<template>
  <main class="page tavern-page">
    <header class="tavern-heading">
      <div>
        <p class="round-mark">Visitor round {{ game.save?.visitRound.number ?? '—' }}</p>
        <h1>Tavern floor</h1>
        <p class="muted">Read each traveler, trade once, then send a commission or let them continue down the road.</p>
      </div>
      <div class="tavern-summary" aria-label="Current resources">
        <span><strong>{{ game.save?.gold ?? 0 }}g</strong> in coffer</span>
        <span><strong>{{ stashUsed }}/{{ stashLimit }}</strong> stash</span>
        <button class="btn ghost" type="button" :disabled="game.loading" @click="reload()">
          {{ game.loading ? 'Refreshing…' : 'Refresh from server' }}
        </button>
      </div>
    </header>

    <div v-if="game.error" class="page-alert page-alert--error" role="alert">
      <div>
        <strong>The tavern could not update.</strong>
        <p>{{ game.error }} Your last confirmed state is still shown.</p>
      </div>
      <button class="btn" type="button" :disabled="game.loading" @click="reload()">Try again</button>
    </div>
    <p v-if="notice" class="page-alert page-alert--success" role="status">{{ notice }}</p>

    <section v-if="game.loading && !game.save" class="visitor-grid" aria-label="Loading visitors" aria-busy="true">
      <article v-for="seat in 2" :key="seat" class="visitor-skeleton">
        <span class="skeleton-line skeleton-line--title" />
        <span class="skeleton-line" />
        <span class="skeleton-block" />
      </article>
    </section>

    <section v-else-if="visitors.length" id="commissions" class="visitor-grid" aria-label="Visitor posts">
      <VisitorPost
        v-for="visitor in visitors"
        :key="visitor.id"
        :visitor="visitor"
        :stash="game.save?.stash ?? []"
        :gold="game.save?.gold ?? 0"
        :stash-limit="stashLimit"
        :quests="game.quests"
        :now="now"
        :pending="game.isVisitorMutationPending(visitor.id)"
        :trade-impact="tradeImpacts[visitor.id]"
        @buy="buy"
        @sell="sell"
        @commission="commission"
        @claim="claim"
        @dismiss="dismiss"
      />
    </section>

    <section v-else class="empty-tavern">
      <h2>No visitors are seated</h2>
      <p class="muted">Refresh to restore the persisted round. A valid round always contains two visitors.</p>
      <button class="btn primary" type="button" :disabled="game.loading" @click="reload()">Restore round</button>
    </section>

    <aside class="tavern-rules" aria-label="Trade rules">
      <h2>The house rules</h2>
      <div>
        <p><strong>One trade per traveler.</strong> Prices and quotes come from the server and stay fixed for this visit.</p>
        <p><strong>No hidden sale.</strong> Unidentified goods must visit the Appraiser before a traveler will buy them.</p>
        <p><strong>Safe retries.</strong> Buttons lock while requests are in flight; a network retry reuses the same request identity.</p>
      </div>
    </aside>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import VisitorPost from '~/components/VisitorPost.vue'
import { useGameStore } from '~/stores/game'
import type { Visitor } from '~/types/game'

interface TradeImpact {
  powerBefore: number
  powerAfter: number
  chances: Array<{ regionId: string; before: number; after: number }>
}

const game = useGameStore()
const now = ref(Date.now())
const notice = ref('')
const tradeImpacts = ref<Record<string, TradeImpact>>({})
const visitors = computed(() => game.save?.visitRound.visitors ?? [])
const stashUsed = computed(() => game.save?.stash.length ?? 0)
const stashLimit = computed(() => game.save?.stashLimit ?? 0)
let timer: ReturnType<typeof setInterval> | undefined
let lastReturnRefresh = 0

onMounted(async () => {
  await reload()
  timer = setInterval(() => {
    now.value = Date.now()
    const returnIsDue = visitors.value.some((visitor) => visitor.state === 'commissioned'
      && visitor.commission
      && new Date(visitor.commission.finishesAt).getTime() <= now.value)
    if (returnIsDue && !game.loading && now.value - lastReturnRefresh >= 5000) {
      lastReturnRefresh = now.value
      void reload(false)
    }
  }, 1000)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

async function reload(clearNotice = true) {
  if (clearNotice) notice.value = ''
  try {
    await game.load()
  } catch {
    // The store keeps the last confirmed save and exposes a recoverable error.
  }
}

async function buy(visitorId: string, offerId: string) {
  await perform('Purchase confirmed.', () => game.buyFromVisitor(visitorId, offerId))
}

async function sell(visitorId: string, itemId: string) {
  const before = visitorSnapshot(visitorId)
  const succeeded = await perform('Sale confirmed.', () => game.sellToVisitor(visitorId, itemId))
  const after = visitorSnapshot(visitorId)
  if (!succeeded || !before || !after || after.power <= before.power) return
  tradeImpacts.value[visitorId] = {
    powerBefore: before.power,
    powerAfter: after.power,
    chances: after.commissionOptions.map((option) => ({
      regionId: option.regionId,
      before: before.commissionOptions.find((entry) => entry.regionId === option.regionId)?.successChance ?? option.successChance,
      after: option.successChance
    }))
  }
  notice.value = `Sale confirmed. ${after.name}'s useful equipment raised their power and commission odds.`
}

async function commission(visitorId: string, regionId: string) {
  await perform('Commission confirmed. The return time is now persisted.', () => game.commissionVisitor(visitorId, regionId))
}

async function claim(visitorId: string) {
  await perform('Return claimed exactly once.', () => game.claimVisitor(visitorId))
}

async function dismiss(visitorId: string) {
  await perform('Visitor departed.', () => game.dismissVisitor(visitorId))
}

async function perform(successMessage: string, action: () => Promise<void>): Promise<boolean> {
  notice.value = ''
  try {
    await action()
    notice.value = successMessage
    return true
  } catch {
    return false
  }
}

function visitorSnapshot(visitorId: string): Visitor | undefined {
  const visitor = game.save?.visitRound.visitors.find((entry) => entry.id === visitorId)
  return visitor ? JSON.parse(JSON.stringify(visitor)) as Visitor : undefined
}
</script>

<style scoped>
.tavern-page { display: grid; gap: 1.25rem; }
.tavern-heading { align-items: end; display: flex; gap: 1.5rem; justify-content: space-between; }
.tavern-heading h1 { font-size: 2rem; letter-spacing: -0.025em; margin: 0.15rem 0 0.35rem; text-wrap: balance; }
.tavern-heading p { margin: 0; max-width: 66ch; text-wrap: pretty; }
.round-mark { color: var(--accent-2); font-size: 0.82rem; font-weight: 750; }
.tavern-summary { align-items: center; display: flex; flex-wrap: wrap; gap: 0.65rem; justify-content: flex-end; }
.tavern-summary > span { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 0.55rem 0.7rem; }
.visitor-grid { display: grid; gap: 1rem; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.page-alert { align-items: center; border-radius: 8px; display: flex; gap: 1rem; justify-content: space-between; padding: 0.8rem 1rem; }
.page-alert p { margin: 0.15rem 0 0; }
.page-alert--error { background: #2b1716; border: 1px solid #7e3732; }
.page-alert--success { background: #17231a; border: 1px solid #315b3b; margin: 0; }
.visitor-skeleton { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; display: grid; gap: 0.8rem; padding: 1rem; }
.skeleton-line, .skeleton-block { animation: pulse 1.5s ease-in-out infinite; background: var(--panel-2); border-radius: 6px; display: block; }
.skeleton-line { height: 1rem; width: 55%; }
.skeleton-line--title { height: 1.8rem; width: 35%; }
.skeleton-block { height: 12rem; width: 100%; }
.empty-tavern { align-items: start; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; display: grid; gap: 0.6rem; justify-items: start; padding: 1.5rem; }
.empty-tavern h2, .empty-tavern p { margin: 0; }
.tavern-rules { border-top: 1px solid var(--line); display: grid; gap: 1rem; grid-template-columns: minmax(10rem, 0.4fr) 1fr; padding-top: 1.25rem; }
.tavern-rules h2 { margin: 0; }
.tavern-rules > div { display: grid; gap: 0.5rem; }
.tavern-rules p { color: var(--muted); margin: 0; }
.tavern-rules strong { color: var(--text); }

@keyframes pulse { 50% { opacity: 0.55; } }

@media (max-width: 850px) { .visitor-grid { grid-template-columns: 1fr; } }

@media (max-width: 640px) {
  .tavern-heading { align-items: stretch; flex-direction: column; }
  .tavern-summary { justify-content: stretch; }
  .tavern-summary > span { flex: 1 1 auto; }
  .tavern-summary .btn { justify-content: center; width: 100%; }
  .page-alert { align-items: stretch; flex-direction: column; }
  .tavern-rules { grid-template-columns: 1fr; }
}

@media (prefers-reduced-motion: reduce) { .skeleton-line, .skeleton-block { animation: none; } }
</style>
