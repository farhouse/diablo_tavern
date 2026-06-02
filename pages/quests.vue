<template>
  <main class="page">
    <div class="section-title">
      <div>
        <h1>Expedition Board</h1>
        <p class="muted">Send available heroes on concurrent timed expeditions.</p>
      </div>
      <NuxtLink class="btn" to="/stash">Open stash</NuxtLink>
    </div>

    <p v-if="game.error" class="error">{{ game.error }}</p>

    <section class="grid two">
      <article class="card stack">
        <div class="row">
          <h2>Party</h2>
          <span class="tag">{{ selectedHeroIds.length }}/4 selected</span>
        </div>
        <p v-if="!availableHeroes.length" class="muted">Hire or recover an available hero first.</p>
        <label v-for="hero in availableHeroes" :key="hero.id" class="row card">
          <span>{{ hero.name }} Lv {{ hero.level }}</span>
          <input
            v-model="selectedHeroIds"
            type="checkbox"
            :value="hero.id"
            :disabled="selectedHeroIds.length >= 4 && !selectedHeroIds.includes(hero.id)"
          >
        </label>
        <div v-for="hero in questingHeroes" :key="hero.id" class="card row">
          <span>{{ hero.name }} Lv {{ hero.level }}</span>
          <span class="tag">on expedition</span>
        </div>
      </article>

      <article class="card stack">
        <h2>Expedition History</h2>
        <div v-if="expeditionHistory.length" class="stack">
          <div v-for="summary in expeditionHistory" :key="summary.id" class="card stack">
            <div class="row">
              <span
                class="tag"
                :class="{
                  success: summary.result === 'success',
                  warning: summary.result === 'retreated',
                  danger: summary.result === 'defeated' || summary.result === 'death'
                }"
              >
                {{ summary.result }}
              </span>
              <span class="tag">{{ questName(summary.questId) }}</span>
            </div>
            <p>{{ summary.depth }} depth reached · {{ summary.xp }} XP · {{ summary.gold }} gold</p>
            <div v-if="summary.loot.length" class="grid two">
              <div v-for="item in summary.loot" :key="item.id" class="card item" :class="item.rarity">
                <strong>{{ itemName(item) }}</strong>
                <p class="muted">{{ item.type }} · {{ item.rarity }} · {{ item.value }}g</p>
              </div>
            </div>
            <p v-else class="muted">No items brought back.</p>
          </div>
        </div>
        <p v-else class="muted">No expeditions completed yet.</p>
      </article>
    </section>

    <section v-if="activeExpeditions.length" class="stack" style="margin-top: 1rem;">
      <h2>Active Expeditions</h2>
      <div class="grid two">
        <article v-for="active in activeExpeditions" :key="active.id" class="card stack">
          <div class="row">
            <h3>{{ questName(active.questId) }}</h3>
            <span class="tag">Depth {{ active.depth }}</span>
          </div>
          <p class="muted">Exploring for {{ timeLabel(active) }}</p>

          <div class="row">
            <span>Danger:</span>
            <progress class="danger-meter" max="100" :value="active.danger" />
          </div>

          <div v-for="state in active.partyState" :key="state.heroId" class="row hero-status">
            <span>{{ heroName(state.heroId) }}:</span>
            <span class="hp-bar-container">
              <progress
                class="hp-bar"
                :max="state.maxTemporaryHp"
                :value="state.temporaryHp"
                :class="{ critical: state.temporaryHp < state.maxTemporaryHp * 0.3 }"
              />
              <span class="hp-text">{{ state.temporaryHp }}/{{ state.maxTemporaryHp }}</span>
            </span>
            <span v-if="state.dead" class="tag danger">DEAD</span>
          </div>

          <div class="row rewards">
            <span>Carried:</span>
            <span class="gold">{{ active.carriedGold }}g</span>
            <span class="xp">{{ active.carriedXp }}xp</span>
          </div>

          <div v-if="active.carriedLoot.length" class="loot-preview">
            <span>Loot:</span>
            <div v-for="item in active.carriedLoot" :key="item.id" class="item loot-item" :class="item.rarity">
              {{ itemName(item) }}
            </div>
          </div>

          <div v-if="active.bossDefeated" class="boss-status">
            <span class="tag success">BOSS DEFEATED!</span>
          </div>
          <div v-else-if="active.bossReady" class="boss-status">
            <span class="tag warning">BOSS READY!</span>
          </div>
          <div v-else class="boss-status">
            <span class="tag">Boss Clues: {{ bossCluesFound(active) }}/10</span>
          </div>

          <div class="actions">
            <button class="btn danger" type="button" @click="recallExpedition(active.id)">
              Recall Party
            </button>
          </div>

          <div v-if="active.events.length" class="event-log">
            <h3>Event Log</h3>
            <div class="log-container">
              <div v-for="event in active.events.slice().reverse().slice(0, 8)" :key="event.id" class="log-entry">
                <span class="timestamp">{{ formatTime(event.createdAt) }}</span>
                <span class="event-title">{{ event.title }}</span>
                <span class="event-description">{{ event.description }}</span>
                <span v-if="event.damageTaken !== undefined" class="effect negative">-{{ event.damageTaken }} HP</span>
                <span v-if="event.xpGained !== undefined" class="effect positive">+{{ event.xpGained }} XP</span>
                <span v-if="event.goldFound !== undefined" class="effect positive">+{{ event.goldFound }}g</span>
                <span v-if="event.lootFound?.length" class="effect positive">+{{ event.lootFound.length }} item{{ event.lootFound.length > 1 ? 's' : '' }}</span>
              </div>
            </div>
          </div>
        </article>
      </div>
    </section>

    <section class="grid three" style="margin-top: 1rem;">
      <article v-for="quest in game.quests" :key="quest.id" class="card stack">
        <div class="row">
          <h3>{{ quest.name }}</h3>
          <span class="tag">Min Lv {{ quest.minLevel }}</span>
        </div>
        <p class="muted">Difficulty {{ quest.difficulty }} · {{ quest.rewards.xp }} XP · {{ quest.rewards.gold }} gold</p>
        <span class="tag" :class="{ ok: isCompleted(quest.id), bad: !isUnlocked(quest.id) }">
          {{ isCompleted(quest.id) ? 'completed' : isUnlocked(quest.id) ? 'unlocked' : 'locked' }}
        </span>
        <button
          class="btn primary"
          type="button"
          :disabled="!canStartQuest(quest.id)"
          @click="startExpedition(quest.id)"
        >
          Send Expedition
        </button>
      </article>
    </section>
  </main>
</template>

<script setup lang="ts">
import type { ActiveExpedition, Item } from '~/types/game'
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

const game = useGameStore()
await game.load()

const selectedHeroIds = ref<string[]>([])

const availableHeroes = computed(() =>
  game.save ? game.save.heroes.filter((hero) => hero.status === 'available') : []
)

const questingHeroes = computed(() =>
  game.save ? game.save.heroes.filter((hero) => hero.status === 'onQuest') : []
)

const activeExpeditions = computed(() => game.save?.activeExpeditions || [])
const expeditionHistory = computed(() => game.save?.expeditionHistory || [])

function isCompleted(questId: string): boolean {
  return Boolean(game.save?.questsProgress.find((progress) => progress.questId === questId)?.completed)
}

function isUnlocked(questId: string): boolean {
  return Boolean(game.save?.questsProgress.find((progress) => progress.questId === questId)?.unlocked)
}

function canStartQuest(questId: string): boolean {
  return isUnlocked(questId) && selectedHeroIds.value.length >= 1 && selectedHeroIds.value.length <= 4
}

function questName(questId: string): string {
  return game.quests.find((quest) => quest.id === questId)?.name || 'Unknown Quest'
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp)
  return date.toTimeString().slice(0, 8)
}

function timeLabel(expedition: ActiveExpedition): string {
  const started = new Date(expedition.startedAt).getTime()
  const seconds = Math.floor((Date.now() - started) / 1000)
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

function bossCluesFound(expedition: ActiveExpedition): number {
  return expedition.events.filter((event) => event.type === 'bossClue').length
}

function heroName(heroId: string): string {
  const hero = game.save?.heroes.find((candidate) => candidate.id === heroId)
  return hero ? hero.name : 'Unknown'
}

function itemName(item: Item): string {
  if (item.identified) return item.displayName
  return `Unidentified ${capitalize(item.rarity)} ${item.baseName}`
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

async function startExpedition(questId: string) {
  try {
    await game.startExpedition(questId, selectedHeroIds.value)
    selectedHeroIds.value = selectedHeroIds.value.filter((id) =>
      game.save?.heroes.find((hero) => hero.id === id)?.status === 'available'
    )
  } catch {
    // Store already records the error.
  }
}

async function advanceExpeditions() {
  try {
    await game.advanceExpeditions()
  } catch {
    // Store already records the error.
  }
}

async function recallExpedition(expeditionId: string) {
  try {
    await game.recallExpedition(expeditionId)
  } catch {
    // Store already records the error.
  }
}

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    if (activeExpeditions.value.length) {
      advanceExpeditions()
    }
  }, 3000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>
