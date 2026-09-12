<template>
  <main class="page">
    <div class="section-title">
      <div>
        <h1>Expedition Board</h1>
        <p class="muted">Send heroes on expeditions to explore and return with loot.</p>
      </div>
      <div class="row" style="gap: 0.5rem;">
        <button class="btn ghost" type="button" @click="showHistory = true" v-if="lastExpeditions.length">
          <span class="icon">📜</span> History ({{ lastExpeditions.length }})
        </button>
      </div>
    </div>

    <p v-if="game.error" class="error">{{ game.error }}</p>

    <section class="grid two">
      <article class="card stack">
        <h2>Party</h2>
        <p class="muted">{{ availableHeroes.length }} / {{ heroCap }} available</p>
        <p v-if="!availableHeroes.length" class="muted">Hire or recover heroes first.</p>
        <label v-for="hero in availableHeroes" :key="hero.id" class="row card">
          <span>{{ hero.name }} Lv {{ hero.level }}</span>
          <input v-model="selectedHeroIds" type="checkbox" :value="hero.id" :disabled="selectedHeroIds.length >= 4 && !selectedHeroIds.includes(hero.id)">
        </label>
        <p v-if="availableHeroes.length && selectedHeroIds.length >= 4" class="muted">Max party size reached.</p>
        <div v-for="hero in questingHeroes" :key="hero.id" class="card row">
          <span>{{ hero.name }} Lv {{ hero.level }}</span>
          <span class="tag">on expedition</span>
        </div>
      </article>

      <article class="card stack expedition-summary">
        <h2>Expeditions</h2>
        <p class="muted">{{ expeditions.length }} / {{ expeditionCap }} active.</p>
        <p v-if="!expeditions.length" class="muted">No active expeditions.</p>
        <p v-else class="muted">Watch party health and recall before a run turns bad.</p>
      </article>
    </section>

    <section v-if="expeditions.length" class="active-expeditions">
      <div class="section-title compact">
        <div>
          <h2>Active Expeditions</h2>
          <p class="muted">Each party keeps loot only if they make it back.</p>
        </div>
      </div>

      <div class="expeditions-carousel">
        <UCard
          v-for="expedition in expeditions"
          :key="expedition.id"
          variant="subtle"
          class="expedition-card-horizontal"
        >
          <div class="expedition-main">
            <div class="expedition-header">
              <div>
                <h3>{{ questName(expedition.questId) }}</h3>
                <p class="muted">{{ timeLabel(expedition) }}</p>
              </div>
              <div class="expedition-badges">
                <UBadge color="neutral" variant="soft">Depth {{ expedition.depth }}</UBadge>
                <UBadge v-if="expedition.status === 'returning'" color="info" variant="soft">Returning</UBadge>
                <UBadge v-else-if="portalActive(expedition)" color="primary" variant="soft">Portal Active</UBadge>
                <UBadge v-if="expedition.bossReady && !expedition.bossDefeated" color="warning" variant="soft">Boss Ready</UBadge>
                <UBadge v-else-if="expedition.bossDefeated" color="success" variant="soft">Boss Defeated</UBadge>
              </div>
            </div>

            <div class="expedition-core">
              <div class="danger-section">
                <div class="row meter-label">
                  <span>Danger</span>
                  <span class="muted">{{ expedition.danger }}%</span>
                </div>
                <UProgress :model-value="expedition.danger" :max="100" color="warning" size="sm" />
              </div>

              <div class="party-section">
                <div v-for="state in expedition.partyState" :key="state.heroId" class="hero-health-horizontal">
                  <div class="hero-avatar">
                    <span>{{ heroName(state.heroId).charAt(0) }}</span>
                  </div>
                  <div class="hero-info">
                    <div class="row meter-label">
                      <span>{{ heroName(state.heroId) }}</span>
                      <UBadge v-if="state.permanentDeath" color="error" variant="soft">Dead</UBadge>
                      <UBadge v-else-if="state.dead" color="warning" variant="soft">Down</UBadge>
                      <span v-else class="muted">{{ state.temporaryHp }}/{{ state.maxTemporaryHp }}</span>
                    </div>
                    <UProgress
                      :model-value="state.temporaryHp"
                      :max="state.maxTemporaryHp"
                      :color="healthColor(state)"
                      size="xs"
                    />
                    <div class="row hero-progress">
                      <span class="muted">Lv {{ state.projectedLevel ?? state.startLevel ?? heroLevel(state.heroId) }}</span>
                      <span class="xp">{{ state.projectedXp ?? state.startXp ?? heroXp(state.heroId) }}/{{ state.xpToNextLevel ?? xpForLevel(state.projectedLevel ?? state.startLevel ?? heroLevel(state.heroId)) }} XP</span>
                      <UBadge v-if="state.leveledUp" color="success" variant="soft" size="sm">Level up</UBadge>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div class="rewards-section">
              <div class="row rewards">
                <span class="gold">{{ expedition.carriedGold }}g</span>
                <span class="material">{{ expedition.carriedMaterials }}m</span>
                <span class="xp">{{ expedition.carriedXp }}xp</span>
                <span v-if="expedition.carriedLoot.length">{{ expedition.carriedLoot.length }} items</span>
              </div>
            </div>
          </div>

          <div class="expedition-sidebar">
            <div v-if="expedition.events.length" class="recent-events">
              <div class="row meter-label">
                <span>Recent Events</span>
                <span class="muted">{{ expedition.events.length }} total</span>
              </div>
              <div v-for="event in expedition.events.slice().reverse().slice(0, 3)" :key="event.id" class="recent-event">
                <div class="event-main">
                  <div class="row event-heading">
                    <span class="event-title">{{ event.title }}</span>
                    <span class="muted">{{ formatTime(event.createdAt) }}</span>
                  </div>
                  <p class="muted">{{ event.description }}</p>
                </div>
                <div class="event-effects">
                  <span v-if="event.damageTaken !== undefined" class="effect negative">-{{ event.damageTaken }} HP</span>
                  <span v-if="event.healingDone !== undefined" class="effect positive">+{{ event.healingDone }} HP</span>
                  <span v-if="event.xpGained !== undefined" class="effect positive">+{{ event.xpGained }} XP</span>
                  <span v-if="event.goldFound !== undefined" class="effect positive">+{{ event.goldFound }}g</span>
                  <span v-if="event.materialsFound !== undefined" class="effect positive">+{{ event.materialsFound }}m</span>
                  <span v-if="event.lootFound?.length" class="effect positive">+{{ event.lootFound.length }} items</span>
                </div>
              </div>
            </div>

            <div class="expedition-actions">
              <div v-if="expedition.status === 'returning' && expedition.returnsAt" class="row" style="justify-content:center;margin-bottom:0.5rem">
                <span class="muted">ETA: {{ etaLabel(expedition.returnsAt) }}</span>
              </div>
              <UButton v-if="expedition.status === 'returning'" color="neutral" variant="soft" type="button" block disabled>
                Returning...
              </UButton>
              <UButton v-else-if="portalActive(expedition)" color="primary" variant="solid" type="button" block @click="recallWithPortal(expedition.id)">
                Use Portal ({{ etaLabel(expedition.portalAvailableUntil!) }})
              </UButton>
              <UButton v-else color="error" variant="soft" type="button" block @click="recall(expedition.id)">
                Recall Party
              </UButton>
            </div>
          </div>
        </UCard>
      </div>
    </section>

    <section class="grid three" style="margin-top:1rem">
      <article v-for="quest in game.quests" :key="quest.id" class="card stack">
        <div class="row">
          <h3>{{ quest.name }}</h3>
          <span class="tag">Min Lv {{ quest.minLevel }}</span>
        </div>
        <span class="tag" :class="{ ok: isCompleted(quest.id), bad: !isUnlocked(quest.id) }">
          {{ isCompleted(quest.id) ? 'completed' : isUnlocked(quest.id) ? 'unlocked' : 'locked' }}
        </span>
        <button class="btn primary" type="button"
                :disabled="hasExpeditionsAtCap || !isUnlocked(quest.id) || !selectedHeroIds.length"
                @click="start(quest.id)">
          {{ hasExpeditionsAtCap ? 'Capacity Full' : 'Send Expedition' }}
        </button>
      </article>
    </section>

    <!-- Expedition History Modal -->
    <Teleport to="body">
      <div v-if="showHistory" class="modal-overlay" @click="showHistory = false">
        <div class="modal-container" @click.stop>
          <div class="modal-header">
            <h2>Expedition History</h2>
            <button class="modal-close" @click="showHistory = false">×</button>
          </div>
          <div class="modal-body">
            <p v-if="!lastExpeditions.length" class="muted">No expeditions completed yet.</p>
            <div v-else class="history-list">
              <article v-for="summary in lastExpeditions" :key="summary.id" class="history-card">
                <div class="history-header">
                  <span class="tag"
                        :class="{ success: summary.result === 'success', warning: summary.result === 'retreated', danger: summary.result === 'defeated' }">
                    {{ summary.result }}
                  </span>
                  <span class="muted">{{ formatDate(summary.createdAt) }}</span>
                </div>
                <p class="muted">{{ questName(summary.questId) }} · Depth {{ summary.depth }}</p>
                <div class="history-stats">
                  <span class="gold">{{ summary.xp }} XP</span>
                  <span class="gold">{{ summary.gold }}g</span>
                  <span class="material">{{ summary.materials }}m</span>
                  <span>{{ summary.loot.length }} items</span>
                </div>
                <div class="history-heroes">
                  <span class="muted">Heroes:</span>
                  <span v-for="hs in summary.heroStatuses" :key="hs.heroId" class="hero-status" :class="hs.status">
                    {{ heroName(hs.heroId) }}: {{ hs.status }}
                  </span>
                </div>
              </article>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn primary" @click="showHistory = false">Close</button>
          </div>
        </div>
      </div>
    </Teleport>

  </main>
</template>

<script setup lang="ts">
import type { Item, ActiveExpedition, ExpeditionHeroState, ExpeditionSummary } from '~/types/game'
import { getExpeditionCapacity, getHeroCapacity } from '~/utils/game-logic'

const game = useGameStore()
onMounted(() => {
  void game.load()
})

const selectedHeroIds = ref<string[]>([])
const showHistory = ref(false)

const heroCap = computed(() => game.save ? getHeroCapacity(game.save) : 0)
const expeditionCap = computed(() => game.save ? getExpeditionCapacity(game.save) : 0)
const expeditions = computed(() => game.save?.activeExpeditions ?? [])
const availableHeroes = computed(() => game.save ? game.save.heroes.filter(h => h.status === 'available') : [])
const questingHeroes = computed(() => game.save ? game.save.heroes.filter(h => h.status === 'onQuest') : [])
const lastExpeditions = computed(() => game.save?.expeditionHistory ?? [])
const hasExpeditionsAtCap = computed(() => expeditions.value.length >= expeditionCap.value)

function questName(questId: string) {
  return game.quests.find(q => q.id === questId)?.name ?? questId
}

function timeLabel(e: ActiveExpedition) {
  const started = new Date(e.startedAt).getTime()
  const seconds = Math.floor((Date.now() - started) / 1000)
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function formatTime(ts: string) {
  return new Date(ts).toTimeString().slice(0, 8)
}

function formatDate(ts: string) {
  return new Date(ts).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function heroName(heroId: string) {
  return game.save?.heroes.find(hero => hero.id === heroId)?.name ?? 'Unknown'
}

function healthColor(state: ExpeditionHeroState) {
  if (state.permanentDeath || state.dead) return 'error'
  const ratio = state.maxTemporaryHp ? state.temporaryHp / state.maxTemporaryHp : 0
  if (ratio <= 0.3) return 'error'
  if (ratio <= 0.55) return 'warning'
  return 'success'
}

function progress(questId: string) {
  return game.save?.questsProgress.find(entry => entry.questId === questId)
}
function isUnlocked(questId: string) { return Boolean(progress(questId)?.unlocked) }
function isCompleted(questId: string) { return Boolean(progress(questId)?.completed) }

async function start(questId: string) {
  try {
    await game.startExpedition(questId, selectedHeroIds.value)
    selectedHeroIds.value = []
  } catch { /* handled */ }
}

function portalActive(expedition: ActiveExpedition): boolean {
  return expedition.status !== 'returning' && !!expedition.portalAvailableUntil && new Date(expedition.portalAvailableUntil).getTime() > Date.now()
}

function etaLabel(timeStr: string): string {
  const diff = new Date(timeStr).getTime() - Date.now()
  if (diff <= 0) return 'now'
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

async function recall(expeditionId: string) {
  try {
    await game.recallExpedition(expeditionId)
  } catch { /* handled */ }
}

async function recallWithPortal(expeditionId: string) {
  try {
    await game.recallExpedition(expeditionId, true)
  } catch { /* handled */ }
}

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(async () => {
    if (expeditions.value.length) {
      try { await game.advanceExpeditions() } catch { /* handled */ }
    }
  }, 3000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.active-expeditions { margin-top: 1rem; }
.section-title.compact { margin-bottom: 0.75rem; }
.expedition-summary { min-height: 100%; }

.expeditions-carousel {
  display: flex;
  gap: 1rem;
  overflow-x: auto;
  padding: 0.5rem 1rem;
  scroll-snap-type: x mandatory;
  -webkit-overflow-scrolling: touch;
  width: 100vw;
  max-width: 100vw;
  margin-left: calc(50% - 50vw);
  margin-right: calc(50% - 50vw);
  box-sizing: border-box;
}
.expeditions-carousel::-webkit-scrollbar {
  height: 6px;
}
.expeditions-carousel::-webkit-scrollbar-track {
  background: var(--background);
  border-radius: 3px;
}
.expeditions-carousel::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 3px;
}

.expedition-card-horizontal {
  flex: 0 0 900px;
  min-width: 900px;
  scroll-snap-align: start;
  display: flex;
  flex-direction: row;
  gap: 1.5rem;
  padding: 1.25rem;
}
.expedition-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}
.expedition-sidebar {
  width: 320px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  border-left: 1px solid var(--border);
  padding-left: 1.25rem;
}

.expedition-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
}
.expedition-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.expedition-core {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.danger-section {
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
}
.party-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.hero-health-horizontal {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  padding: 0.5rem;
  background: var(--background);
  border-radius: 6px;
}
.hero-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--primary);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 0.875rem;
  flex-shrink: 0;
}
.hero-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}
.hero-info .row.meter-label {
  gap: 0.5rem;
}

.rewards-section {
  padding-top: 0.5rem;
  border-top: 1px solid var(--border);
}

.recent-events {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-top: 0.25rem;
}
.recent-event {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.55rem 0;
  border-top: 1px solid rgba(58,52,45,0.45);
  font-size: 0.85rem;
}
.event-main {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.event-heading {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.75rem;
}
.event-effects {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.expedition-actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}

.gold { color: var(--accent-2); }
.material { color: #7eb8da; }
.xp { color: var(--ok); }
.rewards { font-weight: 500; }
.event-title { font-weight: 500; flex: 1; min-width: 8rem; }
.effect {
  font-weight: 500;
  min-width: 3rem;
  padding: 0.1rem 0.35rem;
  border: 1px solid currentColor;
  border-radius: 0.35rem;
}
.positive { color: var(--ok); }
.negative { color: var(--bad); }

@media (max-width: 1024px) {
  .expedition-card-horizontal {
    flex: 0 0 95vw;
    min-width: 95vw;
  }
  .expedition-sidebar {
    width: 100%;
    border-left: none;
    border-top: 1px solid var(--border);
    padding-left: 0;
    padding-top: 1rem;
  }
  .expedition-card-horizontal {
    flex-direction: column;
  }
}

/* Modal Styles - expedition history */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
  animation: fadeIn 0.2s ease;
}
.modal-container {
  background: var(--surface);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  max-width: 700px;
  width: 100%;
  max-height: 85vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  animation: slideUp 0.3s ease;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--border);
}
.modal-header h2 { margin: 0; font-size: 1.25rem; }
.modal-close {
  background: none; border: none; font-size: 1.5rem; cursor: pointer;
  color: var(--text-secondary); padding: 0.25rem 0.5rem; border-radius: 4px;
  transition: all 0.2s ease;
}
.modal-close:hover { background: var(--background-hover); color: var(--text-primary); }
.modal-body {
  padding: 1.5rem;
  overflow-y: auto;
  flex: 1;
}
.history-list { display: flex; flex-direction: column; gap: 0.75rem; }
.history-card {
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1rem;
  transition: all 0.2s ease;
}
.history-card:hover { border-color: var(--primary); box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
.history-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; flex-wrap: wrap; gap: 0.5rem; }
.history-stats { display: flex; gap: 1rem; margin: 0.5rem 0; flex-wrap: wrap; font-size: 0.875rem; }
.history-heroes { display: flex; gap: 0.5rem; flex-wrap: wrap; font-size: 0.875rem; align-items: center; }
.hero-status { padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 500; }
.hero-status.available { background: var(--success); color: white; }
.hero-status.injured { background: var(--warning); color: white; }
.hero-status.dead { background: var(--error); color: white; }
.hero-status.retreated { background: var(--info); color: white; }
.modal-footer {
  display: flex; justify-content: flex-end; padding: 1rem 1.5rem;
  border-top: 1px solid var(--border);
}
</style>
