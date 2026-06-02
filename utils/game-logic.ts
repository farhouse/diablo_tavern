import type { ActiveQuestRun, Affix, DerivedStats, EquipmentSlot, Hero, HeroClass, Item, ItemRarity, Quest, QuestRun, SaveGame, ActiveExpedition, ExpeditionHeroState, ExpeditionEvent, ExpeditionSummary } from '~/types/game'
import { affixPool, heroClassStats, itemBases, itemTypeToSlots, quests, uniqueItems } from '~/utils/game-data'

const STASH_LIMIT = 30
const QUEST_DURATION_SCALE_MS = 1000
const EXPEDITION_EVENT_INTERVAL_MS = 5000
const EXPEDITION_HISTORY_LIMIT = 10
const MAX_EXPEDITION_PARTY_SIZE = 4
const rarityOrder: ItemRarity[] = ['normal', 'magic', 'rare', 'unique']
const rarePrefixes = ['Storm', 'Blood', 'Dread', 'Rune', 'Grim', 'Havoc']
const rareSuffixes = ['Loop', 'Grasp', 'Shelter', 'Song', 'Brand', 'Guard']

export function createSaveGame(userId: string): SaveGame {
  const now = new Date().toISOString()

  return {
    userId,
    gold: 450,
    stashLimit: STASH_LIMIT,
    heroes: [],
    stash: [],
    pendingLoot: [],
    questsProgress: quests.map((quest, index) => ({
      questId: quest.id,
      completed: false,
      unlocked: index === 0
    })),
    activeExpeditions: [],
    expeditionHistory: [],
    createdAt: now,
    updatedAt: now
  }
}

export function normalizeSaveGame(save: SaveGame): SaveGame {
  const legacy = save as SaveGame & {
    activeExpedition?: ActiveExpedition
    lastExpeditionRun?: ExpeditionSummary
  }

  save.activeExpeditions = Array.isArray(save.activeExpeditions) ? save.activeExpeditions : []
  save.expeditionHistory = Array.isArray(save.expeditionHistory) ? save.expeditionHistory : []

  if (legacy.activeExpedition && !save.activeExpeditions.some((expedition) => expedition.id === legacy.activeExpedition?.id)) {
    save.activeExpeditions.push(legacy.activeExpedition)
  }
  if (legacy.lastExpeditionRun && !save.expeditionHistory.some((summary) => summary.id === legacy.lastExpeditionRun?.id)) {
    save.expeditionHistory.unshift(legacy.lastExpeditionRun)
  }

  save.expeditionHistory = save.expeditionHistory.slice(0, EXPEDITION_HISTORY_LIMIT)
  delete legacy.activeExpedition
  delete legacy.lastExpeditionRun
  return save
}

export function createHero(heroClass: HeroClass): Hero {
  const template = heroClassStats[heroClass]
  const hero: Hero = {
    id: randomId(),
    name: template.label,
    class: heroClass,
    level: 1,
    xp: 0,
    baseStats: { ...template.baseStats },
    derivedStats: {
      life: 0,
      mana: 0,
      attackPower: 0,
      defense: 0,
      fireResist: 0,
      coldResist: 0,
      lightningResist: 0,
      poisonResist: 0,
      magicFind: 0
    },
    equipment: {},
    status: 'available'
  }

  hero.derivedStats = calculateDerivedStats(hero)
  return hero
}

export function calculateDerivedStats(hero: Hero): DerivedStats {
  const base = { ...hero.baseStats }
  const flatBonuses: DerivedStats = {
    life: 0,
    mana: 0,
    attackPower: 0,
    defense: 0,
    fireResist: 0,
    coldResist: 0,
    lightningResist: 0,
    poisonResist: 0,
    magicFind: 0
  }

  for (const item of Object.values(hero.equipment)) {
    if (!item?.identified) continue
    collectAffixes(flatBonuses, base, item.affixes)
  }

  const stats: DerivedStats = {
    life: base.vitality * 8 + hero.level * 6 + flatBonuses.life,
    mana: base.energy * 6 + hero.level * 4 + flatBonuses.mana,
    attackPower: base.strength * 2 + base.dexterity + hero.level * 3 + flatBonuses.attackPower,
    defense: base.dexterity + base.vitality + hero.level * 2 + flatBonuses.defense,
    fireResist: flatBonuses.fireResist,
    coldResist: flatBonuses.coldResist,
    lightningResist: flatBonuses.lightningResist,
    poisonResist: flatBonuses.poisonResist,
    magicFind: flatBonuses.magicFind
  }

  return stats
}

export function calculateHeroPower(hero: Hero): number {
  const stats = calculateDerivedStats(hero)
  const resistances = stats.fireResist + stats.coldResist + stats.lightningResist + stats.poisonResist
  return Math.round(stats.attackPower + stats.defense + stats.life * 0.2 + resistances * 0.5)
}

export function calculateSuccessChance(heroes: Hero[], difficulty: number): number {
  const partyPower = heroes.reduce((sum, hero) => sum + calculateHeroPower(hero), 0)
  const rawChance = partyPower / (partyPower + difficulty)
  return Math.max(0.05, Math.min(0.95, rawChance))
}

export function generateLoot(lootTableId: string, magicFind = 0): Item[] {
  const count = lootTableId === 'act1-boss' ? 3 : Math.random() > 0.5 ? 2 : 1
  return Array.from({ length: count }, () => generateItem(lootTableId, magicFind))
}

export function generateItem(lootTableId: string, magicFind = 0): Item {
  const base = pickOne(itemBases)
  const rarity = rollRarity(lootTableId, magicFind)

  if (rarity === 'unique') {
    const candidates = uniqueItems.filter((item) => item.type === base.type)
    const unique = candidates.length ? pickOne(candidates) : uniqueItems[0]
    if (!unique) throw createGameError('Unique item pool is empty')
    return { ...unique, id: randomId(), identified: false }
  }

  const affixCount = rarity === 'normal' ? 0 : rarity === 'magic' ? randomBetween(1, 2) : randomBetween(3, 5)
  const affixes = [...(base.implicit || []), ...pickAffixes(affixCount)]
  const displayName = rarity === 'normal' ? base.baseName : `${capitalize(rarity)} ${base.baseName}`

  return {
    id: randomId(),
    baseName: base.baseName,
    displayName,
    type: base.type,
    rarity,
    identified: rarity === 'normal',
    width: base.width,
    height: base.height,
    requiredLevel: base.requiredLevel,
    affixes,
    value: Math.round(base.value * rarityValueMultiplier(rarity))
  }
}

export function identifyItem(save: SaveGame, itemId: string): SaveGame {
  const item = save.stash.find((stashItem) => stashItem.id === itemId)
  if (!item) throw createGameError('Item not found in stash')
  if (item.identified) return touchSave(save)

  const cost = identifyCost(item.rarity)
  if (save.gold < cost) throw createGameError('Not enough gold')

  item.identified = true
  if (item.rarity === 'rare') item.displayName = `${pickOne(rarePrefixes)} ${pickOne(rareSuffixes)}`
  save.gold -= cost
  return touchSave(save)
}

export function sellItem(save: SaveGame, itemId: string): SaveGame {
  const stashIndex = save.stash.findIndex((item) => item.id === itemId)
  if (stashIndex === -1) throw createGameError('Item not found in stash')
  const [item] = save.stash.splice(stashIndex, 1)
  if (!item) throw createGameError('Item not found in stash')
  save.gold += item.value
  return touchSave(save)
}

export function equipItem(save: SaveGame, heroId: string, itemId: string, slot?: EquipmentSlot): SaveGame {
  const hero = findHero(save, heroId)
  const itemIndex = save.stash.findIndex((item) => item.id === itemId)
  if (itemIndex === -1) throw createGameError('Item not found in stash')

  const item = save.stash[itemIndex]
  if (!item) throw createGameError('Item not found in stash')
  if (!item.identified) throw createGameError('Identify this item before equipping it')
  if (hero.level < item.requiredLevel) throw createGameError('Hero level is too low')

  const allowedSlots = itemTypeToSlots[item.type] as EquipmentSlot[]
  if (!allowedSlots.length) throw createGameError('This item cannot be equipped')
  const targetSlot = slot || allowedSlots.find((candidate) => !hero.equipment[candidate]) || allowedSlots[0]
  if (!targetSlot) throw createGameError('Invalid equipment slot')
  if (!allowedSlots.includes(targetSlot)) throw createGameError('Invalid equipment slot')

  const [removed] = save.stash.splice(itemIndex, 1)
  if (!removed) throw createGameError('Item not found in stash')
  const previous = hero.equipment[targetSlot]
  hero.equipment[targetSlot] = removed
  if (previous) save.stash.push(previous)
  hero.derivedStats = calculateDerivedStats(hero)

  return touchSave(save)
}

export function unequipItem(save: SaveGame, heroId: string, slot: EquipmentSlot): SaveGame {
  if (save.stash.length >= save.stashLimit) throw createGameError('Stash is full')
  const hero = findHero(save, heroId)
  const item = hero.equipment[slot]
  if (!item) throw createGameError('No item in that slot')
  delete hero.equipment[slot]
  save.stash.push(item)
  hero.derivedStats = calculateDerivedStats(hero)
  return touchSave(save)
}

export function startQuest(save: SaveGame, questId: string, heroIds: string[]): SaveGame {
  if (save.activeQuestRun) throw createGameError('A quest is already in progress')
  const quest = quests.find((candidate) => candidate.id === questId)
  if (!quest) throw createGameError('Quest not found')
  const progress = save.questsProgress.find((entry) => entry.questId === questId)
  if (!progress?.unlocked) throw createGameError('Quest is locked')

  const heroes = heroIds.map((id) => findHero(save, id))
  if (!heroes.length) throw createGameError('Select at least one hero')
  if (heroes.some((hero) => hero.status !== 'available')) throw createGameError('All selected heroes must be available')
  if (heroes.some((hero) => hero.level < quest.minLevel)) throw createGameError('A selected hero does not meet the quest level')

  const startedAt = new Date()
  for (const hero of heroes) {
    hero.status = 'onQuest'
  }
  save.activeQuestRun = {
    id: randomId(),
    questId,
    heroIds,
    startedAt: startedAt.toISOString(),
    finishesAt: new Date(startedAt.getTime() + questDurationMs(quest.difficulty)).toISOString()
  }
  return touchSave(save)
}

export function completeActiveQuest(save: SaveGame, now = new Date()): SaveGame {
  const activeRun = save.activeQuestRun
  if (!activeRun) throw createGameError('No quest is in progress')
  if (new Date(activeRun.finishesAt).getTime() > now.getTime()) throw createGameError('Quest is still in progress')

  const quest = quests.find((candidate) => candidate.id === activeRun.questId)
  if (!quest) throw createGameError('Quest not found')
  const progress = save.questsProgress.find((entry) => entry.questId === activeRun.questId)
  if (!progress) throw createGameError('Quest progress not found')

  const heroes = activeRun.heroIds.map((id) => findHero(save, id))
  const magicFind = heroes.reduce((sum, hero) => sum + calculateDerivedStats(hero).magicFind, 0)
  const chance = calculateSuccessChance(heroes, quest.difficulty)
  const success = Math.random() <= chance
  const loot = success ? generateLoot(quest.lootTableId, magicFind) : Math.random() > 0.7 ? [generateItem(quest.lootTableId, magicFind)] : []
  const xpGained = success ? quest.rewards.xp : Math.round(quest.rewards.xp * 0.15)
  const goldGained = success ? quest.rewards.gold : 0

  for (const hero of heroes) {
    hero.xp += Math.round(xpGained / heroes.length)
    levelUpHero(hero)
    hero.status = success || Math.random() > 0.35 ? 'available' : 'injured'
    hero.derivedStats = calculateDerivedStats(hero)
  }

  save.gold += goldGained
  addLootToSave(save, loot)

  if (success) {
    progress.completed = true
    unlockAvailableQuests(save)
  }

  const run: QuestRun = {
    id: activeRun.id,
    questId: activeRun.questId,
    heroIds: activeRun.heroIds,
    result: success ? 'success' : 'failure',
    log: [
      `${heroes.map((hero) => hero.name).join(', ')} entered ${quest.name}.`,
      `Estimated odds were ${Math.round(chance * 100)}%.`,
      success ? 'The party returned victorious.' : 'The party was forced to retreat.'
    ],
    loot,
    xpGained,
    goldGained,
    createdAt: now.toISOString()
  }
  save.lastQuestRun = run
  delete save.activeQuestRun

  return touchSave(save)
}

export function recoverHero(save: SaveGame, heroId: string): SaveGame {
  const hero = findHero(save, heroId)
  if (hero.status === 'injured') hero.status = 'available'
  return touchSave(save)
}

export function identifyCost(rarity: ItemRarity): number {
  if (rarity === 'magic') return 50
  if (rarity === 'rare') return 150
  if (rarity === 'unique') return 500
  return 0
}

export function publicItemName(item: Item): string {
  if (item.identified) return item.displayName
  return `Unidentified ${capitalize(item.rarity)} ${item.baseName}`
}

export function touchSave(save: SaveGame): SaveGame {
  save.updatedAt = new Date().toISOString()
  return save
}

function addLootToSave(save: SaveGame, loot: Item[]) {
  for (const item of loot) {
    if (save.stash.length < save.stashLimit) save.stash.push(item)
    else save.pendingLoot.push(item)
  }
}

function collectAffixes(derived: DerivedStats, base: { [key: string]: number }, affixes: Affix[]) {
  for (const affix of affixes) {
    if (affix.stat in derived) {
      derived[affix.stat as keyof DerivedStats] += affix.value
    } else if (affix.stat in base) {
      base[affix.stat] = (base[affix.stat] || 0) + affix.value
    }
  }
}

function levelUpHero(hero: Hero) {
  while (hero.xp >= xpForNextLevel(hero.level)) {
    hero.xp -= xpForNextLevel(hero.level)
    hero.level += 1
    hero.baseStats.strength += hero.class === 'barbarian' ? 2 : 1
    hero.baseStats.dexterity += 1
    hero.baseStats.vitality += hero.class === 'paladin' || hero.class === 'barbarian' ? 2 : 1
    hero.baseStats.energy += hero.class === 'sorceress' || hero.class === 'necromancer' ? 2 : 1
  }
}

function unlockAvailableQuests(save: SaveGame) {
  for (const quest of quests) {
    const progress = save.questsProgress.find((entry) => entry.questId === quest.id)
    if (!progress || progress.unlocked) continue
    const completedIds = quest.requirements?.completedQuestIds || []
    progress.unlocked = completedIds.every((id) => save.questsProgress.find((entry) => entry.questId === id)?.completed)
  }
}

function findHero(save: SaveGame, heroId: string): Hero {
  const hero = save.heroes.find((candidate) => candidate.id === heroId)
  if (!hero) throw createGameError('Hero not found')
  return hero
}

function findActiveExpedition(save: SaveGame, expeditionId: string): ActiveExpedition {
  const expedition = save.activeExpeditions.find((candidate) => candidate.id === expeditionId)
  if (!expedition) throw createGameError('Expedition not found')
  return expedition
}

function rollRarity(lootTableId: string, magicFind: number): ItemRarity {
  const roll = Math.random() * 100
  const bossBonus = lootTableId === 'act1-boss' ? 8 : 0
  const mfBonus = Math.min(12, magicFind / 5)
  if (roll > 98 - bossBonus - mfBonus) return 'unique'
  if (roll > 82 - bossBonus - mfBonus) return 'rare'
  if (roll > 45 - mfBonus) return 'magic'
  return 'normal'
}

function questDurationMs(difficulty: number): number {
  const seconds = Math.max(10, Math.min(30, Math.round(difficulty / 8)))
  return seconds * QUEST_DURATION_SCALE_MS
}

function pickAffixes(count: number): Affix[] {
  const pool = [...affixPool]
  const affixes: Affix[] = []
  for (let index = 0; index < count && pool.length; index += 1) {
    const [affix] = pool.splice(Math.floor(Math.random() * pool.length), 1)
    if (!affix) continue
    affixes.push({ ...affix, value: Math.round(affix.value * randomBetween(1, 3)) })
  }
  return affixes
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function rarityValueMultiplier(rarity: ItemRarity): number {
  return rarityOrder.indexOf(rarity) + 1
}

function xpForNextLevel(level: number): number {
  return 100 + level * 75
}

function pickOne<T>(values: T[]): T {
  const value = values[Math.floor(Math.random() * values.length)]
  if (value === undefined) throw createGameError('Cannot pick from an empty list')
  return value
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

function createGameError(message: string): Error {
  return new Error(message)
}

function randomId(): string {
  return globalThis.crypto.randomUUID()
}

// Expedition logic

export function startExpedition(save: SaveGame, questId: string, heroIds: string[], now: Date = new Date()): SaveGame {
  normalizeSaveGame(save)
  if (save.activeQuestRun) throw createGameError('A quest is already in progress')
  const quest = quests.find((candidate) => candidate.id === questId)
  if (!quest) throw createGameError('Quest not found')
  const progress = save.questsProgress.find((entry) => entry.questId === questId)
  if (!progress?.unlocked) throw createGameError('Quest is locked')

  const uniqueHeroIds = [...new Set(heroIds)]
  const heroes = uniqueHeroIds.map((id) => findHero(save, id))
  if (!heroes.length) throw createGameError('Select at least one hero')
  if (heroes.length > MAX_EXPEDITION_PARTY_SIZE) throw createGameError(`Select up to ${MAX_EXPEDITION_PARTY_SIZE} heroes`)
  if (heroes.some((hero) => hero.status !== 'available')) throw createGameError('All selected heroes must be available')
  if (heroes.some((hero) => hero.level < quest.minLevel)) throw createGameError('A selected hero does not meet the quest level')

  // Mark heroes as onQuest
  for (const hero of heroes) {
    hero.status = 'onQuest'
  }

  // Create expedition state
  const expedition: ActiveExpedition = {
    id: randomId(),
    questId,
    heroIds: uniqueHeroIds,
    status: "exploring",
    startedAt: now.toISOString(),
    lastEventAt: now.toISOString(),
    nextEventAt: new Date(now.getTime() + EXPEDITION_EVENT_INTERVAL_MS).toISOString(),
    depth: 0,
    danger: 0,
    partyState: heroes.map(hero => ({
      heroId: hero.id,
      temporaryHp: hero.derivedStats.life,
      maxTemporaryHp: hero.derivedStats.life,
      dead: false
    })),
    events: [],
    carriedLoot: [],
    carriedGold: 0,
    carriedXp: 0,
    bossReady: false,
    bossDefeated: false
  }

  save.activeExpeditions.push(expedition)
  return touchSave(save)
}

export function advanceExpedition(save: SaveGame, now: Date = new Date(), expeditionId?: string): SaveGame {
  normalizeSaveGame(save)
  const expeditions = expeditionId
    ? [findActiveExpedition(save, expeditionId)]
    : save.activeExpeditions

  if (!expeditions.length) return touchSave(save)
  for (const expedition of expeditions) {
    advanceSingleExpedition(save, expedition, now)
  }
  return touchSave(save)
}

function advanceSingleExpedition(save: SaveGame, expedition: ActiveExpedition, now: Date): void {
  const nowTime = now.getTime()
  const lastEventTime = new Date(expedition.lastEventAt).getTime()
  const quest = quests.find(q => q.id === expedition.questId)
  if (!quest) throw createGameError('Quest not found')

  // Calculate how many events should have occurred
  const eventsMissed = Math.floor((nowTime - lastEventTime) / EXPEDITION_EVENT_INTERVAL_MS)
  const eventsToGenerate = Math.min(eventsMissed, 5) // max 5 events per advance to prevent bursts

  if (eventsToGenerate <= 0) return

  // Generate events
  for (let i = 0; i < eventsToGenerate; i++) {
    const eventTime = new Date(lastEventTime + ((i + 1) * EXPEDITION_EVENT_INTERVAL_MS)).toISOString()
    const event = generateExpeditionEvent(expedition, quest, new Date(eventTime))
    expedition.events.push(event)
    applyExpeditionEvent(expedition, event)
  }

  // Update expedition timers
  expedition.lastEventAt = new Date(lastEventTime + (eventsToGenerate * EXPEDITION_EVENT_INTERVAL_MS)).toISOString()
  expedition.nextEventAt = new Date(new Date(expedition.lastEventAt).getTime() + EXPEDITION_EVENT_INTERVAL_MS).toISOString()

  // Update depth and danger based on events
  expedition.depth += eventsToGenerate
  expedition.danger = Math.min(100, expedition.depth) // Simple danger calculation

  // Check for boss readiness
  if (!expedition.bossReady && expedition.depth >= 100 && expedition.heroIds.some(id => {
    const hero = save.heroes.find(h => h.id === id)
    return hero && hero.level >= 10
  })) {
    expedition.bossReady = true
    expedition.status = 'bossReady'
  }
}

export function recallExpedition(save: SaveGame, expeditionId: string, now: Date = new Date()): SaveGame {
  normalizeSaveGame(save)
  const expedition = findActiveExpedition(save, expeditionId)

  // First advance to current time to process any pending events
  advanceSingleExpedition(save, expedition, now)

  // Determine result based on expedition state
  const allDead = expedition.partyState.every(state => state.dead)
  const anyDowned = expedition.partyState.some(state => state.dead)
  const anyInjured = expedition.partyState.some(state => !state.dead && state.temporaryHp < state.maxTemporaryHp * 0.5)
  const result: ExpeditionSummary['result'] = allDead ? 'death' : anyDowned || anyInjured ? 'retreated' : 'success'

  if (allDead) {
    expedition.carriedGold = Math.floor(expedition.carriedGold * 0.5)
    const lootToKeep = Math.ceil(expedition.carriedLoot.length * 0.5)
    expedition.carriedLoot = expedition.carriedLoot.slice(0, lootToKeep)
  }

  // Transfer carried rewards to save
  save.gold += expedition.carriedGold
  addLootToSave(save, expedition.carriedLoot)

  // Apply XP to surviving heroes
  const survivorIds = expedition.partyState.filter((state) => !state.dead).map((state) => state.heroId)
  const xpPerHero = survivorIds.length ? Math.floor(expedition.carriedXp / survivorIds.length) : 0
  for (const heroId of expedition.heroIds) {
    const hero = findHero(save, heroId)

    // Update hero status based on expedition state
    const state = expedition.partyState.find(s => s.heroId === heroId)
    if (!state) throw createGameError('Expedition hero state not found')
    if (state?.dead) {
      hero.status = state.permanentDeath ? 'dead' : 'injured'
    } else if (state.temporaryHp < state.maxTemporaryHp * 0.5) {
      hero.xp += xpPerHero
      levelUpHero(hero)
      hero.status = 'injured'
    } else {
      hero.xp += xpPerHero
      levelUpHero(hero)
      hero.status = 'available'
    }
    hero.derivedStats = calculateDerivedStats(hero)
  }

  // Create summary
  const summary: ExpeditionSummary = {
    id: expedition.id,
    questId: expedition.questId,
    heroIds: expedition.heroIds,
    result,
    depth: expedition.depth,
    durationMs: now.getTime() - new Date(expedition.startedAt).getTime(),
    loot: [...expedition.carriedLoot],
    gold: expedition.carriedGold,
    xp: expedition.carriedXp,
    heroesStatus: [...expedition.partyState],
    events: [...expedition.events]
  }

  // Clear expedition and save summary
  save.activeExpeditions = save.activeExpeditions.filter((activeExpedition) => activeExpedition.id !== expedition.id)
  save.expeditionHistory = [summary, ...save.expeditionHistory].slice(0, EXPEDITION_HISTORY_LIMIT)

  return touchSave(save)
}

function generateExpeditionEvent(expedition: ActiveExpedition, quest: Quest, now: Date): ExpeditionEvent {
  const typeRoll = pickExpeditionEventType(expedition)
  let type: ExpeditionEvent['type']
  let title = ''
  let description = ''
  let damageTaken: number | undefined
  let xpGained: number | undefined
  let goldFound: number | undefined
  let lootFound: Item[] | undefined
  let depthGained: number | undefined

  if (typeRoll === 'enemy') {
    type = 'enemy'
    title = 'Enemy Encounter'
    description = 'The party encountered hostile forces.'
    damageTaken = Math.floor(Math.random() * 10) + 5
    xpGained = Math.floor(Math.random() * 15) + 5
    if (Math.random() < 0.3) goldFound = Math.floor(Math.random() * 10) + 5
  } else if (typeRoll === 'treasure') {
    type = 'treasure'
    title = 'Treasure Found'
    description = 'The party discovered a hidden cache.'
    goldFound = Math.floor(Math.random() * 20) + 10
    if (Math.random() < 0.4) {
      lootFound = [generateItem(quest.lootTableId, 0)]
    }
  } else if (typeRoll === 'trap') {
    type = 'trap'
    title = 'Trap Triggered'
    description = 'The party triggered a dangerous trap.'
    damageTaken = Math.floor(Math.random() * 15) + 10
  } else if (typeRoll === 'rest') {
    type = 'rest'
    title = 'Safe Haven'
    description = 'The party found a place to rest and recover.'
    // Healing is applied in applyExpeditionEvent
  } else if (typeRoll === 'champion') {
    type = 'champion'
    title = 'Champion Encounter'
    description = 'A powerful champion blocked the party\'s path.'
    damageTaken = Math.floor(Math.random() * 20) + 15
    xpGained = Math.floor(Math.random() * 25) + 15
    if (Math.random() < 0.5) goldFound = Math.floor(Math.random() * 15) + 10
    if (Math.random() < 0.3) {
      lootFound = [generateItem(quest.lootTableId, 5)]
    }
  } else if (typeRoll === 'evilHero') {
    type = 'evilHero'
    title = 'Evil Hero Encounter'
    description = 'A fallen hero corrupted by darkness ambushed the party.'
    damageTaken = Math.floor(Math.random() * 25) + 20
    xpGained = Math.floor(Math.random() * 30) + 20
    if (Math.random() < 0.4) goldFound = Math.floor(Math.random() * 20) + 15
    if (Math.random() < 0.4) {
      lootFound = [generateItem(quest.lootTableId, 10)]
    }
  } else if (typeRoll === 'bossClue') {
    type = 'bossClue'
    title = 'Boss Clue Found'
    description = 'The party discovered evidence of the boss\'s presence.'
    depthGained = Math.floor(Math.random() * 10) + 5
  } else {
    type = 'boss'
    title = 'Boss Encounter'
    description = 'The party has reached the boss chamber!'
    damageTaken = Math.floor(Math.random() * 30) + 20
    xpGained = Math.floor(Math.random() * 50) + 30
    if (Math.random() < 0.6) goldFound = Math.floor(Math.random() * 50) + 25
    if (Math.random() < 0.5) {
      lootFound = [generateItem(quest.lootTableId, 15)]
    }
    expedition.bossDefeated = true
  }

  return {
    id: randomId(),
    type,
    createdAt: now.toISOString(),
    title,
    description,
    damageTaken,
    xpGained,
    goldFound,
    lootFound,
    depthGained
  }
}

function applyExpeditionEvent(expedition: ActiveExpedition, event: ExpeditionEvent): void {
  // Apply damage to heroes
  if (event.damageTaken !== undefined) {
    const livingStates = expedition.partyState.filter((state) => !state.dead)
    const damagePerHero = livingStates.length ? Math.max(1, Math.floor(event.damageTaken / livingStates.length)) : 0
    for (const state of livingStates) {
      state.temporaryHp = Math.max(0, state.temporaryHp - damagePerHero)
      if (state.temporaryHp <= 0) {
        state.dead = true
        if (Math.random() < 0.08) {
          state.permanentDeath = true
          expedition.events.push({
            id: randomId(),
            type: 'death',
            createdAt: event.createdAt,
            title: 'Hero Fallen',
            description: `A hero has succumbed to their wounds.`,
            damageTaken: 0
          })
        }
      }
    }
  }

  // Apply healing from rest events
  if (event.type === 'rest') {
    const healAmount = Math.floor(20 + Math.random() * 20) // Heal 20-40 HP
    for (const state of expedition.partyState) {
      if (!state.dead) {
        state.temporaryHp = Math.min(state.maxTemporaryHp, state.temporaryHp + healAmount)
      }
    }
  }

  // Apply rewards
  if (event.xpGained !== undefined) {
    expedition.carriedXp += event.xpGained
  }
  if (event.goldFound !== undefined) {
    expedition.carriedGold += event.goldFound
  }
  if (event.lootFound?.length) {
    expedition.carriedLoot.push(...event.lootFound)
  }
  if (event.depthGained !== undefined) {
    expedition.depth += event.depthGained
  }
}

function pickExpeditionEventType(expedition: ActiveExpedition): Exclude<ExpeditionEvent['type'], 'death' | 'return'> {
  const danger = Math.min(1, expedition.depth / 100)
  const weights: Array<[Exclude<ExpeditionEvent['type'], 'death' | 'return'>, number]> = [
    ['enemy', 36 + danger * 10],
    ['treasure', 20],
    ['trap', 10 + danger * 8],
    ['rest', Math.max(4, 10 - danger * 5)],
    ['champion', 8 + danger * 5],
    ['evilHero', 5 + danger * 4],
    ['bossClue', expedition.bossReady ? 0 : 5],
    ['boss', expedition.bossReady && !expedition.bossDefeated ? 12 : 0]
  ]
  const totalWeight = weights.reduce((sum, [, weight]) => sum + weight, 0)
  let roll = Math.random() * totalWeight
  for (const [type, weight] of weights) {
    roll -= weight
    if (roll <= 0) return type
  }
  return 'enemy'
}
