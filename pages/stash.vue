<template>
  <main class="page">
    <div class="section-title">
      <div>
        <h1>Stash</h1>
        <p class="muted">{{ stashUsed }} / {{ stashCap }} slots used.</p>
      </div>
      <div class="row">
        <button class="btn ghost" type="button" @click="reload">Refresh</button>
        <button class="btn ghost" type="button" @click="game.reset">Reset save</button>
      </div>
    </div>

    <p v-if="game.error" class="error">{{ game.error }}</p>
    <p v-if="game.save?.pendingLoot.length" class="error">{{ game.save.pendingLoot.length }} items are pending because the stash is full.</p>

    <section class="grid three">
      <article v-for="item in game.save?.stash" :key="item.id" class="card item stack" :class="item.rarity">
        <div class="row">
          <h3>{{ itemName(item) }}</h3>
          <span class="tag">{{ item.rarity }}</span>
        </div>
        <p class="muted">{{ item.type }} · Lv {{ item.requiredLevel }} · {{ item.width }}x{{ item.height }} · {{ item.value }}g</p>
        <div v-if="item.identified" class="stack">
          <span v-for="affix in item.affixes" :key="`${item.id}-${affix.stat}`" class="muted">+{{ affix.value }} {{ affix.stat }}</span>
        </div>
        <div v-if="!item.identified" class="row">
          <button class="btn" type="button" @click="game.identify(item.id)">
            Identify {{ identifyCost(item.rarity) ? `(${identifyCost(item.rarity)}g)` : '' }}
          </button>
          <button v-if="hasAppraiser" class="btn" type="button" :disabled="isInQueue(item.id) || isQueueFull" @click="queueAppraise(item.id)">
            {{ isInQueue(item.id) ? 'In queue' : 'Send to Appraiser' }}
          </button>
        </div>
        <div class="row">
          <button class="btn ghost" type="button" @click="game.sell(item.id)">Sell {{ item.value }}g</button>
        </div>
        <label v-if="item.identified && item.type !== 'charm'" class="field">
          <span>Equip to</span>
          <select @change="equipToHero(item.id, ($event.target as HTMLSelectElement).value)">
            <option value="">Choose hero</option>
            <option v-for="hero in equippableHeroes" :key="hero.id" :value="hero.id">{{ hero.name }} Lv {{ hero.level }}</option>
          </select>
        </label>
      </article>
    </section>
  </main>
</template>

<script setup lang="ts">
import type { Item, ItemRarity } from '~/types/game'
import { getStashCapacity, getAppraiserQueueSize } from '~/utils/game-logic'

const game = useGameStore()

async function reload() {
  await game.load()
}
onMounted(() => {
  void reload()
})

const stashCap = computed(() => game.save ? getStashCapacity(game.save) : 0)
const stashUsed = computed(() => game.save?.stash.length ?? 0)
const hasAppraiser = computed(() => (game.save?.caravan.upgrades.appraiser ?? 0) >= 1)
const appraiserQueue = computed(() => game.save?.caravan.services.appraiserQueue ?? [])
const isQueueFull = computed(() => appraiserQueue.value.length >= (game.save ? getAppraiserQueueSize(game.save) : 0))
const equippableHeroes = computed(() => game.save?.heroes.filter(hero => hero.status !== 'dead') ?? [])

function isInQueue(itemId: string) {
  return appraiserQueue.value.some(j => j.itemId === itemId)
}

function itemName(item: Item): string {
  if (item.identified) return item.displayName
  return `Unidentified ${capitalize(item.rarity)} ${item.baseName}`
}

function identifyCost(rarity: ItemRarity): number {
  if (rarity === 'magic') return 50
  if (rarity === 'rare') return 150
  if (rarity === 'unique') return 500
  return 0
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

async function equipToHero(itemId: string, heroId: string) {
  if (!heroId) return
  try { await game.equip(heroId, itemId) } catch { /* handled */ }
}

async function queueAppraise(itemId: string) {
  try { await game.startAppraisal(itemId) } catch { /* handled */ }
}
</script>
