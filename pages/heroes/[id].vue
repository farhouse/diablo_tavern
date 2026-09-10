<template>
  <main class="page">
    <div class="section-title">
      <div>
        <h1>{{ hero?.name || 'Hero' }}</h1>
        <p v-if="hero" class="muted">{{ hero.class }} · Level {{ hero.level }} · {{ hero.xp }} XP toward next level</p>
      </div>
      <NuxtLink class="btn" to="/tavern">Back</NuxtLink>
    </div>

    <p v-if="!hero" class="error">Hero not found.</p>

    <section v-else class="grid two">
      <article class="card stack">
        <h2>Stats</h2>
        <div class="stat-grid">
          <span class="stat">Life {{ hero.derivedStats.life }}</span>
          <span class="stat">Mana {{ hero.derivedStats.mana }}</span>
          <span class="stat">Attack {{ hero.derivedStats.attackPower }}</span>
          <span class="stat">Defense {{ hero.derivedStats.defense }}</span>
          <span class="stat">Fire {{ hero.derivedStats.fireResist }}</span>
          <span class="stat">Cold {{ hero.derivedStats.coldResist }}</span>
          <span class="stat">Lightning {{ hero.derivedStats.lightningResist }}</span>
          <span class="stat">Poison {{ hero.derivedStats.poisonResist }}</span>
          <span class="stat">Magic Find {{ hero.derivedStats.magicFind }}</span>
        </div>
      </article>

      <article class="card stack">
        <h2>Equipment</h2>
        <div v-for="slot in slots" :key="slot" class="card equipment-row">
          <div class="row">
            <div>
              <span class="tag">{{ slotLabel(slot) }}</span>
              <h3>{{ equippedName(slot) }}</h3>
              <p v-if="hero.equipment[slot]" class="muted">
                {{ hero.equipment[slot]?.type }} · {{ hero.equipment[slot]?.rarity }} · Lv {{ hero.equipment[slot]?.requiredLevel }}
              </p>
            </div>
            <UButton color="neutral" variant="soft" type="button" @click="openSlot(slot)">
              Manage
            </UButton>
          </div>

          <div v-if="hero.equipment[slot]?.affixes.length" class="affix-list">
            <span v-for="affix in hero.equipment[slot]?.affixes" :key="`${slot}-${affix.stat}-${affix.value}`" class="tag ok">
              +{{ affix.value }} {{ statLabel(affix.stat) }}
            </span>
          </div>
          <p v-else class="muted">No item bonuses.</p>
        </div>
      </article>
    </section>

    <UModal v-model:open="modalOpen" :title="selectedSlot ? `Manage ${slotLabel(selectedSlot)}` : 'Manage Equipment'">
      <template #body>
        <div v-if="hero && selectedSlot" class="stack">
          <section class="modal-section">
            <div class="row">
              <div>
                <span class="tag">Equipped</span>
                <h3>{{ equippedName(selectedSlot) }}</h3>
                <p v-if="hero.equipment[selectedSlot]" class="muted">
                  {{ hero.equipment[selectedSlot]?.type }} · {{ hero.equipment[selectedSlot]?.rarity }} · Lv {{ hero.equipment[selectedSlot]?.requiredLevel }}
                </p>
              </div>
              <UButton
                v-if="hero.equipment[selectedSlot]"
                color="neutral"
                variant="ghost"
                type="button"
                @click="unequipSelected"
              >
                Unequip
              </UButton>
            </div>

            <div v-if="hero.equipment[selectedSlot]?.affixes.length" class="affix-list">
              <span
                v-for="affix in hero.equipment[selectedSlot]?.affixes"
                :key="`modal-${selectedSlot}-${affix.stat}-${affix.value}`"
                class="tag ok"
              >
                +{{ affix.value }} {{ statLabel(affix.stat) }}
              </span>
            </div>
            <p v-else class="muted">No item bonuses.</p>
          </section>

          <section class="modal-section stack">
            <div class="row">
              <h3>Stash Options</h3>
              <span class="tag">{{ equipOptions(selectedSlot).length }} matching</span>
            </div>

            <p v-if="unidentifiedOptions(selectedSlot).length" class="muted">
              {{ unidentifiedOptions(selectedSlot).length }} matching item{{ unidentifiedOptions(selectedSlot).length === 1 ? '' : 's' }} must be identified in the stash first.
            </p>
            <p v-if="!equipOptions(selectedSlot).length" class="muted">No identified matching stash items.</p>

            <div class="modal-item-grid">
              <div
                v-for="item in equipOptions(selectedSlot)"
                :key="`${selectedSlot}-${item.id}`"
                class="card item stack"
                :class="item.rarity"
              >
                <div class="row">
                  <div>
                    <strong>{{ itemName(item) }}</strong>
                    <p class="muted">{{ item.type }} · {{ item.rarity }} · Lv {{ item.requiredLevel }}</p>
                  </div>
                  <UButton color="primary" variant="solid" type="button" :disabled="!canEquip(item)" @click="equipSelected(item.id)">
                    Equip
                  </UButton>
                </div>

                <div v-if="item.identified && item.affixes.length" class="affix-list">
                  <span v-for="affix in item.affixes" :key="`${item.id}-${affix.stat}-${affix.value}`" class="tag">
                    +{{ affix.value }} {{ statLabel(affix.stat) }}
                  </span>
                </div>
              <p v-else class="muted">No item bonuses.</p>

              <p v-if="hero.level < item.requiredLevel" class="error">
                Requires level {{ item.requiredLevel }}.
              </p>
              </div>
            </div>
          </section>
        </div>
      </template>
    </UModal>
  </main>
</template>

<script setup lang="ts">
import type { EquipmentSlot, Item, StatKey } from '~/types/game'
import { itemTypeToSlots } from '~/utils/game-data'

const route = useRoute()
const game = useGameStore()
onMounted(() => {
  void game.load()
})

const slots: EquipmentSlot[] = ['weapon', 'helmet', 'armor', 'gloves', 'boots', 'amulet', 'ring1', 'ring2']
const hero = computed(() => game.save?.heroes.find((candidate) => candidate.id === route.params.id))
const selectedSlot = ref<EquipmentSlot | null>(null)
const modalOpen = ref(false)

watch(modalOpen, (open) => {
  if (!open) selectedSlot.value = null
})

function equipOptions(slot: EquipmentSlot): Item[] {
  return matchingSlotItems(slot).filter((item) => item.identified)
}

function unidentifiedOptions(slot: EquipmentSlot): Item[] {
  return matchingSlotItems(slot).filter((item) => !item.identified)
}

function matchingSlotItems(slot: EquipmentSlot): Item[] {
  return (game.save?.stash || []).filter((item) => (itemTypeToSlots[item.type] as EquipmentSlot[]).includes(slot))
}

function canEquip(item: Item): boolean {
  return Boolean(hero.value && hero.value.level >= item.requiredLevel)
}

async function equip(slot: EquipmentSlot, itemId: string) {
  if (!hero.value) return
  const item = game.save?.stash.find((candidate) => candidate.id === itemId)
  if (!item?.identified) return
  await game.equip(hero.value.id, itemId, slot)
}

async function equipSelected(itemId: string) {
  if (!selectedSlot.value) return
  await equip(selectedSlot.value, itemId)
  closeEquipmentModal()
}

async function unequip(slot: EquipmentSlot) {
  if (!hero.value) return
  await game.unequip(hero.value.id, slot)
}

async function unequipSelected() {
  if (!selectedSlot.value) return
  await unequip(selectedSlot.value)
  closeEquipmentModal()
}

function openSlot(slot: EquipmentSlot) {
  selectedSlot.value = slot
  modalOpen.value = true
}

function closeEquipmentModal() {
  modalOpen.value = false
  selectedSlot.value = null
}

function equippedName(slot: EquipmentSlot): string {
  const item = hero.value?.equipment[slot]
  return item ? itemName(item) : 'Empty'
}

function itemName(item: Item): string {
  if (item.identified) return item.displayName
  return `Unidentified ${capitalize(item.rarity)} ${item.baseName}`
}

function slotLabel(slot: EquipmentSlot): string {
  const labels: Record<EquipmentSlot, string> = {
    weapon: 'Weapon',
    helmet: 'Helmet',
    armor: 'Armor',
    gloves: 'Gloves',
    boots: 'Boots',
    amulet: 'Amulet',
    ring1: 'Ring 1',
    ring2: 'Ring 2'
  }
  return labels[slot]
}

function statLabel(stat: StatKey): string {
  return stat.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase())
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}
</script>
