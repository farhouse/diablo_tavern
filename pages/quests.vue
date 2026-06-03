<template>
  <main class="page">
    <div class="section-title">
      <div>
        <h1>Expedition Board</h1>
        <p class="muted">Send heroes on expeditions to explore and return with loot.</p>
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

      <div class="expedition-grid">
        <UCard
          v-for="expedition in expeditions"
          :key="expedition.id"
          variant="subtle"
          class="expedition-card"
          :ui="{ body: 'stack expedition-body', footer: 'expedition-footer' }"
        >
          <template #header>
            <div class="row">
              <div>
                <h3>{{ questName(expedition.questId) }}</h3>
                <p class="muted">{{ timeLabel(expedition) }}</p>
              </div>
              <div class="row">
                <UBadge color="neutral" variant="soft">Depth {{ expedition.depth }}</UBadge>
                <UBadge v-if="expedition.bossReady && !expedition.bossDefeated" color="warning" variant="soft">Boss Ready</UBadge>
                <UBadge v-else-if="expedition.bossDefeated" color="success" variant="soft">Boss Defeated</UBadge>
              </div>
            </div>
          </template>

          <div class="meter-block">
            <div class="row meter-label">
              <span>Danger</span>
              <span class="muted">{{ expedition.danger }}%</span>
            </div>
            <UProgress :model-value="expedition.danger" :max="100" color="warning" size="sm" />
          </div>

          <div class="party-health">
            <div v-for="state in expedition.partyState" :key="state.heroId" class="hero-health">
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
            </div>
          </div>

          <div class="row rewards">
            <span class="gold">{{ expedition.carriedGold }}g</span>
            <span class="material">{{ expedition.carriedMaterials }}m</span>
            <span class="xp">{{ expedition.carriedXp }}xp</span>
            <span v-if="expedition.carriedLoot.length">{{ expedition.carriedLoot.length }} items</span>
          </div>

          <div v-if="expedition.events.length" class="recent-events">
            <div class="row meter-label">
              <span>Recent Events</span>
              <span class="muted">{{ expedition.events.length }} total</span>
            </div>
            <div v-for="event in expedition.events.slice().reverse().slice(0, 5)" :key="event.id" class="recent-event">
              <div class="event-main">
                <div class="row event-heading">
                  <span class="event-title">{{ event.title }}</span>
                  <span class="muted">{{ formatTime(event.createdAt) }}</span>
                </div>
                <p class="muted">{{ event.description }}</p>
              </div>
              <div class="event-effects">
                <span v-if="event.damageTaken !== undefined" class="effect negative">-{{ event.damageTaken }} HP</span>
                <span v-if="event.xpGained !== undefined" class="effect positive">+{{ event.xpGained }} XP</span>
                <span v-if="event.goldFound !== undefined" class="effect positive">+{{ event.goldFound }}g</span>
                <span v-if="event.materialsFound !== undefined" class="effect positive">+{{ event.materialsFound }}m</span>
                <span v-if="event.lootFound?.length" class="effect positive">+{{ event.lootFound.length }} items</span>
              </div>
            </div>
          </div>

          <template #footer>
            <UButton color="error" variant="soft" type="button" block @click="recall(expedition.id)">
              Recall Party
            </UButton>
          </template>
        </UCard>
      </div>
    </section>

    <section v-if="lastExpeditions.length" class="grid three" style="margin-top:1rem">
      <article v-for="summary in lastExpeditions" :key="summary.id" class="card stack">
        <span class="tag"
              :class="{ success: summary.result === 'success', warning: summary.result === 'retreated', danger: summary.result === 'defeated' }">
          {{ summary.result }}
        </span>
        <p class="muted">{{ questName(summary.questId) }} · Depth {{ summary.depth }}</p>
        <p>{{ summary.xp }} XP · {{ summary.gold }}g · {{ summary.materials }}m</p>
        <p class="muted">{{ summary.loot.length }} items</p>
      </article>
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

  </main>
</template>

<script setup lang="ts">
import type { Item, ActiveExpedition, ExpeditionHeroState } from '~/types/game'
import { getExpeditionCapacity, getHeroCapacity } from '~/utils/game-logic'

const game = useGameStore()
await game.load()

const selectedHeroIds = ref<string[]>([])

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

async function recall(expeditionId: string) {
  try {
    await game.recallExpedition(expeditionId)
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
.expedition-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1rem;
}
.expedition-card { border-left: 3px solid var(--accent); }
.expedition-body { gap: 0.9rem; }
.expedition-footer { padding-top: 0.75rem; }
.meter-block,
.party-health {
  display: grid;
  gap: 0.55rem;
}
.hero-health {
  display: grid;
  gap: 0.35rem;
}
.meter-label {
  font-size: 0.9rem;
  gap: 0.5rem;
}
.recent-events {
  display: grid;
  gap: 0.5rem;
  padding-top: 0.25rem;
}
.recent-event {
  display: grid;
  gap: 0.4rem;
  padding: 0.55rem 0;
  border-top: 1px solid rgba(58,52,45,0.45);
  font-size: 0.85rem;
}
.event-main {
  display: grid;
  gap: 0.2rem;
}
.event-heading {
  align-items: baseline;
  gap: 0.75rem;
}
.event-effects {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.boss-status .warning {
  color: var(--accent-2);
  border-color: var(--accent-2);
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
</style>
