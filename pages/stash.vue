<template>
  <main class="page">
    <div class="section-title">
      <div>
        <h1>Stash</h1>
        <p class="muted">{{ game.save?.stash.length || 0 }} / {{ game.save?.stashLimit || 0 }} slots used.</p>
      </div>
      <button class="btn ghost" type="button" @click="game.reset">Reset save</button>
    </div>

    <p v-if="game.error" class="error">{{ game.error }}</p>
    <p v-if="game.save?.pendingLoot.length" class="error">{{ game.save.pendingLoot.length }} items are pending because the stash is full.</p>

    <section class="grid three">
      <article v-for="item in game.save?.stash" :key="item.id" class="card item stack" :class="item.rarity">
        <div class="row">
          <h3>{{ itemName(item) }}</h3>
          <span class="tag">{{ item.rarity }}</span>
        </div>
        <p class="muted">{{ item.type }} · Lv {{ item.requiredLevel }} · {{ item.width }}x{{ item.height }}</p>
        <div v-if="item.identified" class="stack">
          <span v-for="affix in item.affixes" :key="`${item.id}-${affix.stat}`" class="muted">+{{ affix.value }} {{ affix.stat }}</span>
        </div>
        <div class="row">
          <button class="btn" type="button" :disabled="item.identified" @click="game.identify(item.id)">
            Identify {{ identifyCost(item.rarity) ? `(${identifyCost(item.rarity)}g)` : '' }}
          </button>
          <button class="btn ghost" type="button" @click="game.sell(item.id)">Sell {{ item.value }}g</button>
        </div>
        <label v-if="item.identified && item.type !== 'charm'" class="field">
          <span>Equip to</span>
          <select @change="equipToHero(item.id, ($event.target as HTMLSelectElement).value)">
            <option value="">Choose hero</option>
            <option v-for="hero in game.save?.heroes" :key="hero.id" :value="hero.id">{{ hero.name }} Lv {{ hero.level }}</option>
          </select>
        </label>
      </article>
    </section>
  </main>
</template>

<script setup lang="ts">
import type { Item, ItemRarity } from '~/types/game'

const game = useGameStore()
await game.load()

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
  try {
    await game.equip(heroId, itemId)
  } catch {
    // Store already records the error.
  }
}
</script>
