<template>
  <main class="page">
    <div class="section-title">
      <div>
        <h1>Tavern</h1>
        <p class="muted">Hire heroes and manage your roster.</p>
      </div>
      <button class="btn ghost" type="button" @click="game.load">Refresh</button>
    </div>

    <p v-if="game.error" class="error">{{ game.error }}</p>

    <section class="grid two">
      <article class="card stack">
        <h2>Hire</h2>
        <p class="muted">Select one candidate to inspect stats before hiring. Cost: {{ hireCost }} gold.</p>
        <div class="grid two">
          <button
            v-for="option in classOptions"
            :key="option.value"
            class="card hire-card"
            :class="{ selected: selectedClass === option.value }"
            type="button"
            @click="toggleCandidate(option.value)"
          >
            <span class="row">
              <strong>{{ option.label }}</strong>
              <span class="tag">{{ option.role }}</span>
            </span>
            <span class="muted">{{ option.description }}</span>
          </button>
        </div>

        <div v-if="selectedCandidate" class="card stack">
          <div class="row">
            <div>
              <h3>{{ selectedCandidate.label }}</h3>
              <p class="muted">{{ selectedCandidate.description }}</p>
            </div>
            <span class="tag">{{ hireCost }} gold</span>
          </div>

          <div class="stat-grid">
            <span class="stat">Strength {{ selectedPreview.baseStats.strength }}</span>
            <span class="stat">Dexterity {{ selectedPreview.baseStats.dexterity }}</span>
            <span class="stat">Vitality {{ selectedPreview.baseStats.vitality }}</span>
            <span class="stat">Energy {{ selectedPreview.baseStats.energy }}</span>
            <span class="stat">Life {{ selectedPreview.derivedStats.life }}</span>
            <span class="stat">Mana {{ selectedPreview.derivedStats.mana }}</span>
            <span class="stat">Attack {{ selectedPreview.derivedStats.attackPower }}</span>
            <span class="stat">Defense {{ selectedPreview.derivedStats.defense }}</span>
          </div>

          <p v-if="!hasEnoughGold" class="error">Need {{ hireCost - (game.save?.gold || 0) }} more gold.</p>
          <p v-else-if="isRosterFull" class="error">Roster is full.</p>

          <div class="row">
            <button class="btn primary" type="button" :disabled="!canHireSelected || hiring" @click="hireSelected">
              {{ hiring ? 'Hiring...' : 'Hire selected' }}
            </button>
            <button class="btn ghost" type="button" @click="selectedClass = null">Clear</button>
          </div>
        </div>

        <p v-else class="muted">No candidate selected.</p>
      </article>

      <article class="card stack">
        <h2>Roster</h2>
        <p v-if="!game.save?.heroes.length" class="muted">No heroes hired yet.</p>
        <div v-for="hero in game.save?.heroes" :key="hero.id" class="card">
          <div class="row">
            <div>
              <h3>{{ hero.name }} <span class="muted">Lv {{ hero.level }}</span></h3>
              <span class="tag" :class="{ bad: hero.status === 'injured', ok: hero.status === 'available' }">{{ hero.status }}</span>
            </div>
            <div class="row">
              <button v-if="hero.status === 'injured'" class="btn" type="button" @click="game.recover(hero.id)">Recover</button>
              <NuxtLink class="btn" :to="`/heroes/${hero.id}`">Details</NuxtLink>
            </div>
          </div>
          <div class="stat-grid">
            <span class="stat">Power {{ hero.derivedStats.attackPower }}</span>
            <span class="stat">Defense {{ hero.derivedStats.defense }}</span>
            <span class="stat">Life {{ hero.derivedStats.life }}</span>
          </div>
        </div>
      </article>
    </section>
  </main>
</template>

<script setup lang="ts">
import type { HeroClass } from '~/types/game'
import { heroClassStats } from '~/utils/game-data'
import { createHero } from '~/utils/game-logic'

const game = useGameStore()
await game.load()

const selectedClass = ref<HeroClass | null>(null)
const hiring = ref(false)

const classOptions: Array<{ label: string; value: HeroClass; role: string; description: string }> = [
  { label: 'Barbarian', value: 'barbarian', role: 'Frontline', description: 'High life and physical attack.' },
  { label: 'Sorceress', value: 'sorceress', role: 'Damage', description: 'High mana and burst power, low defense.' },
  { label: 'Paladin', value: 'paladin', role: 'Defense', description: 'Strong vitality and reliable defenses.' },
  { label: 'Necromancer', value: 'necromancer', role: 'Balanced', description: 'Flexible stats with strong energy growth.' }
]

const hireCost = computed(() => 120 + (game.save?.heroes.length || 0) * 80)
const selectedCandidate = computed(() => classOptions.find((option) => option.value === selectedClass.value))
const selectedPreview = computed(() => createHero(selectedClass.value || 'barbarian'))
const hasEnoughGold = computed(() => Boolean(game.save && game.save.gold >= hireCost.value))
const isRosterFull = computed(() => Boolean(game.save && game.save.heroes.length >= 8))
const canHireSelected = computed(() => Boolean(selectedClass.value && hasEnoughGold.value && !isRosterFull.value))

function toggleCandidate(heroClass: HeroClass) {
  selectedClass.value = selectedClass.value === heroClass ? null : heroClass
}

async function hireSelected() {
  if (!selectedClass.value || !canHireSelected.value || hiring.value) return
  hiring.value = true
  try {
    await game.hire(selectedClass.value)
    selectedClass.value = null
  } catch {
    // Store already records the error.
  } finally {
    hiring.value = false
  }
}
</script>
