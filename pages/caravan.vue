<template>
  <main class="page">
    <div class="section-title">
      <div>
        <h1>Caravan</h1>
        <p class="muted">Expand your caravan to unlock more heroes, expeditions, and services.</p>
      </div>
    </div>

    <p v-if="game.error" class="error">{{ game.error }}</p>

    <section class="grid two">
      <article class="card stack">
        <h2>Resources</h2>
        <div class="row"><span>Gold:</span><span>{{ game.save?.gold ?? 0 }}</span></div>
        <div class="row"><span>Materials:</span><span class="material">{{ game.save?.materials ?? 0 }}</span></div>
        <div class="row"><span>Caravan Level:</span><span>{{ game.save?.caravan.level ?? 0 }}</span></div>
      </article>

      <article v-if="appraiserLevel > 0" class="card stack">
        <h2>Appraiser Queue</h2>
        <p class="muted">{{ appraiserQueue.length }} / {{ appraiserLevel }} slots used</p>
        <div v-for="job in appraiserQueue" :key="job.id" class="card row">
          <span>{{ itemNameById(job.itemId) }}</span>
          <span class="tag">{{ timeRemaining(job) }}</span>
        </div>
        <div v-if="!appraiserQueue.length" class="muted">Queue is empty.</div>
        <button class="btn" type="button" @click="completeAppraisal">Process ready</button>
      </article>
    </section>

    <section class="upgrade-grid">
      <article v-for="upgrade in upgrades" :key="upgrade.id" class="card stack">
        <h3>{{ upgrade.label }}</h3>
        <p class="muted">{{ upgrade.description }}</p>
        <p>Level {{ currentLevel(upgrade.id) }} / {{ maxLevel(upgrade.id) }}</p>
        <p class="muted">{{ upgradeStatus(upgrade.id) }}</p>
        <div v-if="canUpgrade(upgrade.id)">
          <p>Cost: {{ upgradeCost(upgrade.id)?.gold }}g + {{ upgradeCost(upgrade.id)?.materials }}m</p>
          <button class="btn primary" type="button" :disabled="!canAfford(upgrade.id) || upgrading === upgrade.id" @click="doUpgrade(upgrade.id)">
            {{ upgrading === upgrade.id ? 'Upgrading...' : 'Upgrade' }}
          </button>
          <p v-if="!canAfford(upgrade.id)" class="error">Not enough resources</p>
        </div>
        <p v-else class="effect-warning">MAX LEVEL</p>
      </article>
    </section>
  </main>
</template>

<script setup lang="ts">
import type { CaravanUpgradeId } from '~/types/game'
import { getUpgradeCost, getMaxUpgradeLevel } from '~/utils/game-logic'
import { caravanUpgradeCosts } from '~/utils/game-data'

const game = useGameStore()
await game.load()

const upgrading = ref<CaravanUpgradeId | null>(null)

const upgrades = [
  { id: 'wagons' as CaravanUpgradeId, label: 'Wagons', description: 'Increase hero roster capacity.' },
  { id: 'scoutTable' as CaravanUpgradeId, label: 'Scout Table', description: 'Allow more simultaneous expeditions.' },
  { id: 'stashWagon' as CaravanUpgradeId, label: 'Stash Wagon', description: 'Expand stash slots.' },
  { id: 'infirmary' as CaravanUpgradeId, label: 'Infirmary', description: 'Reduce injury and death risk for heroes.' },
  { id: 'appraiser' as CaravanUpgradeId, label: 'Appraiser', description: 'Identify items for free over time.' }
]

const appraiserLevel = computed(() => game.save?.caravan.upgrades.appraiser ?? 0)
const appraiserQueue = computed(() => game.save?.caravan.services.appraiserQueue ?? [])

function currentLevel(id: CaravanUpgradeId) {
  return game.save?.caravan.upgrades[id] ?? 0
}

function maxLevel(id: CaravanUpgradeId) {
  return getMaxUpgradeLevel(id)
}

function upgradeCost(id: CaravanUpgradeId) {
  const lvl = currentLevel(id)
  return getUpgradeCost(id, lvl)
}

function canUpgrade(id: CaravanUpgradeId) {
  return currentLevel(id) < maxLevel(id)
}

function canAfford(id: CaravanUpgradeId) {
  const cost = upgradeCost(id)
  if (!cost || !game.save) return false
  return game.save.gold >= cost.gold && game.save.materials >= cost.materials
}

function upgradeStatus(id: CaravanUpgradeId) {
  const lvl = currentLevel(id)
  const descs: Record<string, string[]> = {
    wagons: ['3 heroes', '5 heroes', '8 heroes', '12 heroes'],
    scoutTable: ['1 expedition', '2 expeditions', '3 expeditions', '4 expeditions'],
    stashWagon: ['20 slots', '30 slots', '45 slots', '60 slots'],
    infirmary: ['Injury below 50% HP', 'Injury below 35% HP', 'Injury below 25% HP', 'Injury below 18% HP'],
    appraiser: ['No appraiser', '1 queue slot', '2 queue slots', '3 queue slots']
  }
  return descs[id]?.[lvl] ?? ''
}

function itemNameById(itemId: string): string {
  const item = game.save?.stash.find(st => st.id === itemId)
  if (!item) return 'Unknown item'
  if (item.identified) return item.displayName
  return `Unidentified ${capitalize(item.rarity)} ${item.baseName}`
}

function timeRemaining(job: { finishesAt: string }): string {
  const remaining = new Date(job.finishesAt).getTime() - Date.now()
  if (remaining <= 0) return 'Ready!'
  const mins = Math.ceil(remaining / 60000)
  return `${mins} min`
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

async function doUpgrade(id: CaravanUpgradeId) {
  if (upgrading.value) return
  upgrading.value = id
  try {
    await game.upgradeCaravan(id)
  } catch {
    // handled by store
  } finally {
    upgrading.value = null
  }
}

async function completeAppraisal() {
  try {
    await game.completeAppraisal()
  } catch {
    // handled by store
  }
}
</script>

<style scoped>
.upgrade-grid {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  margin-top: 1rem;
}

.material {
  color: #7eb8da;
  font-weight: 500;
}
</style>
