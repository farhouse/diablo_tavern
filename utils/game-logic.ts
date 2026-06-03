import type { ActiveQuestRun, Affix, DerivedStats, EquipmentSlot, Hero, HeroClass, Item, ItemRarity, Quest, QuestRun, SaveGame, ActiveExpedition, ExpeditionHeroState, ExpeditionEvent, ExpeditionSummary, CaravanUpgradeId, CaravanState, AppraisalJob } from '~/types/game'
import { affixPool, heroClassStats, itemBases, itemTypeToSlots, quests, uniqueItems, caravanUpgradeCosts, heroCapacities, expeditionCapacities, stashCapacities, infirmaryLevels, deathChanceReduction, appraiserQueueSizes } from '~/utils/game-data'

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
    materials: 0,
    caravan: {
      level: 0,
      upgrades: { wagons: 0, scoutTable: 0, stashWagon: 0, infirmary: 0, appraiser: 0 },
      services: { appraiserQueue: [] }
    },
    stashLimit: 20,
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
  if (!('materials' in save)) (save as Record<string, unknown>).materials = 0
  if (!('caravan' in save)) {
    (save as Record<string, unknown>).caravan = {
      level: 0,
      upgrades: { wagons: 0, scoutTable: 0, stashWagon: 0, infirmary: 0, appraiser: 0 },
      services: { appraiserQueue: [] }
    }
  }
  const car = save.caravan
  if (typeof car.level !== 'number') car.level = 0
  if (!car.upgrades) car.upgrades = { wagons: 0, scoutTable: 0, stashWagon: 0, infirmary: 0, appraiser: 0 }
  if (!car.services) car.services = { appraiserQueue: [] }
  if (!Array.isArray(car.services.appraiserQueue)) car.services.appraiserQueue = []

  const stashLvl: 0 | 1 | 2 | 3 = Math.min(3, Math.max(0, car.upgrades.stashWagon)) as 0 | 1 | 2 | 3
  const caravanStashLimit = stashCapacities[stashLvl]
  if (typeof save.stashLimit !== 'number' || save.stashLimit < caravanStashLimit) {
    save.stashLimit = caravanStashLimit
  }

  const legacy = save as SaveGame & {
    activeExpedition?: ActiveExpedition
    lastExpeditionRun?: ExpeditionSummary
  }

  save.activeExpeditions = Array.isArray(save.activeExpeditions) ? save.activeExpeditions : []
  save.expeditionHistory = Array.isArray(save.expeditionHistory) ? save.expeditionHistory : []

  if (legacy.activeExpedition && !save.activeExpeditions.some((expedition) => expedition.id === legacy.activeExpedition?.id)) {
    save.activeExpeditions.push(legacy.activeExpedition)
  }

  for (const expedition of save.activeExpeditions) {
    const record = expedition as ActiveExpedition & Record<string, unknown>
    if (!Array.isArray(record.partyState)) record.partyState = []
    if (!Array.isArray(record.events)) record.events = []
    if (!Array.isArray(record.carriedLoot)) record.carriedLoot = []
    if (typeof record.carriedGold !== 'number') record.carriedGold = 0
    if (typeof record.carriedXp !== 'number') record.carriedXp = 0
    if (typeof record.carriedMaterials !== 'number') record.carriedMaterials = 0
    if (typeof record.bossReady !== 'boolean') record.bossReady = record.status === 'bossReady'
    if (typeof record.bossDefeated !== 'boolean') record.bossDefeated = false
    if (record.status === 'returning' && !record.returnsAt) {
      record.status = 'exploring'
    }
  }

  if (legacy.lastExpeditionRun && !save.expeditionHistory.some((summary) => summary.id === legacy.lastExpeditionRun?.id)) {
    const oldRun = legacy.lastExpeditionRun as unknown as Record<string, unknown>
    if (!('heroStatuses' in oldRun)) {
      oldRun.heroStatuses = []
    }
    if (typeof oldRun.materials !== 'number') {
      oldRun.materials = 0
    }
    save.expeditionHistory.unshift(legacy.lastExpeditionRun)
  }

  save.expeditionHistory = save.expeditionHistory.slice(0, EXPEDITION_HISTORY_LIMIT)
  delete legacy.activeExpedition
  delete legacy.lastExpeditionRun
  return save
}

// --- Caravan capacity functions ---

function safeIndex<T>(arr: readonly [T, T, T, T], index: number): T {
  return arr[Math.min(3, Math.max(0, index)) as 0 | 1 | 2 | 3]
}

export function getHeroCapacity(save: SaveGame): number {
  return safeIndex(heroCapacities, save.caravan.upgrades.wagons)
}

export function getActiveHeroCount(save: SaveGame): number {
  return save.heroes.filter((hero) => hero.status !== 'dead').length
}

export function getHireCost(save: SaveGame): number {
  return 120 + getActiveHeroCount(save) * 80
}

export function getExpeditionCapacity(save: SaveGame): number {
  return safeIndex(expeditionCapacities, save.caravan.upgrades.scoutTable)
}

export function getStashCapacity(save: SaveGame): number {
  return safeIndex(stashCapacities, save.caravan.upgrades.stashWagon)
}

export function getInfirmaryReduction(save: SaveGame): number {
  return safeIndex(infirmaryLevels, save.caravan.upgrades.infirmary)
}

export function getDeathChanceReduction(save: SaveGame): number {
  return safeIndex(deathChanceReduction, save.caravan.upgrades.infirmary)
}

export function getAppraiserQueueSize(save: SaveGame): number {
  return safeIndex(appraiserQueueSizes, save.caravan.upgrades.appraiser)
}

export function getUpgradeCost(upgradeId: CaravanUpgradeId, level: number): { gold: number; materials: number } | null {
  const costs = caravanUpgradeCosts[upgradeId]
  if (!costs || level + 1 >= costs.length || level < 0) return null
  const cost = costs[level + 1]
  return cost ?? null
}

export function getMaxUpgradeLevel(upgradeId: CaravanUpgradeId): number {
  return (caravanUpgradeCosts[upgradeId]?.length || 1) - 1
}

export function upgradeCaravan(save: SaveGame, upgradeId: CaravanUpgradeId): SaveGame {
  normalizeSaveGame(save)
  const currentLevel = save.caravan.upgrades[upgradeId]
  const maxLevel = getMaxUpgradeLevel(upgradeId)
  if (currentLevel >= maxLevel) throw createGameError('Upgrade is already at max level')

  const cost = getUpgradeCost(upgradeId, currentLevel)
  if (!cost) throw createGameError('Upgrade cost not found')

  if (save.gold < cost.gold) throw createGameError('Not enough gold')
  if (save.materials < cost.materials) throw createGameError('Not enough materials')

  save.gold -= cost.gold
  save.materials -= cost.materials
  save.caravan.upgrades[upgradeId] = currentLevel + 1
  save.caravan.level = Math.max(save.caravan.level, currentLevel + 1)

  // Recalculate derived capacities
  save.stashLimit = getStashCapacity(save)

  return touchSave(save)
}

// --- Appraiser ---

export function startAppraisal(save: SaveGame, itemId: string): SaveGame {
  normalizeSaveGame(save)
  const queueSize = getAppraiserQueueSize(save)
  if (queueSize <= 0) throw createGameError('Appraiser not available. Upgrade your caravan.')

  const item = save.stash.find((stashItem) => stashItem.id === itemId)
  if (!item) throw createGameError('Item not found in stash')
  if (item.identified) throw createGameError('Item is already identified')
  if (save.caravan.services.appraiserQueue.some((job) => job.itemId === itemId)) throw createGameError('Item is already in the appraiser queue')
  if (save.caravan.services.appraiserQueue.length >= queueSize) throw createGameError('Appraiser queue is full')

  const durationMinutes = item.rarity === 'magic' ? 5 : item.rarity === 'rare' ? 15 : item.rarity === 'unique' ? 30 : 0
  if (durationMinutes <= 0) throw createGameError('Item does not need appraisal')

  const now = new Date()
  const job: AppraisalJob = {
    id: randomId(),
    itemId,
    startedAt: now.toISOString(),
    finishesAt: new Date(now.getTime() + durationMinutes * 60 * 1000).toISOString()
  }

  save.caravan.services.appraiserQueue.push(job)
  return touchSave(save)
}

export function completeAppraisalQueue(save: SaveGame): SaveGame {
  normalizeSaveGame(save)
  const now = new Date()
  const completed: AppraisalJob[] = []
  const remaining: AppraisalJob[] = []

  for (const job of save.caravan.services.appraiserQueue) {
    if (new Date(job.finishesAt).getTime() <= now.getTime()) {
      completed.push(job)
    } else {
      remaining.push(job)
    }
  }

  for (const job of completed) {
    const item = save.stash.find((stashItem) => stashItem.id === job.itemId)
    if (item && !item.identified) {
      item.identified = true
      if (item.rarity === 'rare') item.displayName = `${pickOne(rarePrefixes)} ${pickOne(rareSuffixes)}`
    }
  }

  save.caravan.services.appraiserQueue = remaining
  return touchSave(save)
}

// --- Hero creation ---

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
  if (hero.status === 'dead') throw createGameError('Dead heroes cannot equip items')
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

// --- Expedition logic ---

export function startExpedition(save: SaveGame, questId: string, heroIds: string[], now: Date = new Date()): SaveGame {
  normalizeSaveGame(save)
  if (save.activeQuestRun) throw createGameError('A quest is already in progress')

  const expeditionCap = getExpeditionCapacity(save)
  if (save.activeExpeditions.length >= expeditionCap) throw createGameError('Expedition capacity reached. Upgrade Scout Table.')

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

  for (const hero of heroes) {
    hero.status = 'onQuest'
  }

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
    carriedMaterials: 0,
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

function advanceSingleExpedition(save: SaveGame, expedition: ActiveExpedition, now: Date, skipPortal = false): void {
  const nowTime = now.getTime()

  // Clear expired portal
  if (expedition.portalAvailableUntil && new Date(expedition.portalAvailableUntil).getTime() <= nowTime) {
    delete expedition.portalAvailableUntil
    delete expedition.portalEventId
  }

  // Returning expedition: check if return is complete, otherwise skip
  if (expedition.status === 'returning') {
    if (expedition.returnsAt && new Date(expedition.returnsAt).getTime() <= nowTime) {
      completeExpeditionReturn(save, expedition, now)
    }
    return
  }

  // Normal event generation for exploring/bossReady expeditions
  const lastEventTime = new Date(expedition.lastEventAt).getTime()
  const quest = quests.find(q => q.id === expedition.questId)
  if (!quest) throw createGameError('Quest not found')

  const eventsMissed = Math.floor((nowTime - lastEventTime) / EXPEDITION_EVENT_INTERVAL_MS)
  const eventsToGenerate = Math.min(eventsMissed, 5)

  if (eventsToGenerate <= 0) return

  for (let i = 0; i < eventsToGenerate; i++) {
    const eventTime = new Date(lastEventTime + ((i + 1) * EXPEDITION_EVENT_INTERVAL_MS)).toISOString()
    const event = generateExpeditionEvent(save, expedition, quest, new Date(eventTime), skipPortal)
    expedition.events.push(event)
    applyExpeditionEvent(save, expedition, event)
  }

  // Clean portal if still expired after catch-up event generation
  if (expedition.portalAvailableUntil && new Date(expedition.portalAvailableUntil).getTime() <= nowTime) {
    delete expedition.portalAvailableUntil
    delete expedition.portalEventId
  }

  expedition.lastEventAt = new Date(lastEventTime + (eventsToGenerate * EXPEDITION_EVENT_INTERVAL_MS)).toISOString()
  expedition.nextEventAt = new Date(new Date(expedition.lastEventAt).getTime() + EXPEDITION_EVENT_INTERVAL_MS).toISOString()

  expedition.depth += eventsToGenerate
  expedition.danger = Math.min(100, expedition.depth)

  if (!expedition.bossReady && expedition.depth >= 100 && expedition.heroIds.some(id => {
    const hero = save.heroes.find(h => h.id === id)
    return hero && hero.level >= 10
  })) {
    expedition.bossReady = true
    expedition.status = 'bossReady'
  }
}

export function recallExpedition(save: SaveGame, expeditionId: string, now: Date = new Date(), options?: { usePortal?: boolean }): SaveGame {
  normalizeSaveGame(save)
  const expedition = findActiveExpedition(save, expeditionId)

  // Portal recall: complete immediately
  if (options?.usePortal) {
    const portalExpired = !expedition.portalAvailableUntil || new Date(expedition.portalAvailableUntil).getTime() <= now.getTime()
    if (portalExpired) throw createGameError('Portal is no longer available')
    delete expedition.portalAvailableUntil
    delete expedition.portalEventId
    completeExpeditionReturn(save, expedition, now)
    return touchSave(save)
  }

  // If already returning, just touch
  if (expedition.status === 'returning') return touchSave(save)

  // Advance up to now before starting return (skip portal generation)
  advanceSingleExpedition(save, expedition, now, true)

  // Start timed return
  expedition.status = 'returning'
  expedition.returnStartedAt = now.toISOString()
  const elapsed = now.getTime() - new Date(expedition.startedAt).getTime()
  expedition.returnsAt = new Date(now.getTime() + Math.floor(elapsed / 2)).toISOString()
  delete expedition.portalAvailableUntil
  delete expedition.portalEventId

  return touchSave(save)
}

function completeExpeditionReturn(save: SaveGame, expedition: ActiveExpedition, now: Date): void {
  const allDead = expedition.partyState.every(state => state.dead)
  const anyDowned = expedition.partyState.some(state => state.dead)
  const injuryThreshold = getInfirmaryReduction(save)
  const anyInjured = expedition.partyState.some(state => !state.dead && state.temporaryHp < state.maxTemporaryHp * injuryThreshold)
  const result: ExpeditionSummary['result'] = allDead ? 'defeated' : anyDowned || anyInjured ? 'retreated' : 'success'

  if (allDead) {
    expedition.carriedGold = Math.floor(expedition.carriedGold * 0.5)
    expedition.carriedMaterials = Math.floor(expedition.carriedMaterials * 0.5)
    const lootToKeep = Math.ceil(expedition.carriedLoot.length * 0.5)
    expedition.carriedLoot = expedition.carriedLoot.slice(0, lootToKeep)
  }

  save.gold += expedition.carriedGold
  save.materials += expedition.carriedMaterials
  addLootToSave(save, expedition.carriedLoot)

  const survivorIds = expedition.partyState.filter((state) => !state.dead).map((state) => state.heroId)
  const xpPerHero = survivorIds.length ? Math.floor(expedition.carriedXp / survivorIds.length) : 0
  const heroStatuses: ExpeditionSummary['heroStatuses'] = []

  for (const heroId of expedition.heroIds) {
    const hero = findHero(save, heroId)
    const state = expedition.partyState.find(s => s.heroId === heroId)
    if (!state) throw createGameError('Expedition hero state not found')

    if (state.dead) {
      hero.status = state.permanentDeath ? 'dead' : 'injured'
      heroStatuses.push({ heroId, status: state.permanentDeath ? 'dead' : 'injured' })
    } else if (state.temporaryHp < state.maxTemporaryHp * injuryThreshold) {
      hero.xp += xpPerHero
      levelUpHero(hero)
      hero.status = 'injured'
      heroStatuses.push({ heroId, status: 'injured' })
    } else {
      hero.xp += xpPerHero
      levelUpHero(hero)
      hero.status = 'available'
      heroStatuses.push({ heroId, status: 'available' })
    }
    hero.derivedStats = calculateDerivedStats(hero)
  }

  const summary: ExpeditionSummary = {
    id: expedition.id,
    questId: expedition.questId,
    heroIds: expedition.heroIds,
    heroStatuses,
    result,
    depth: expedition.depth,
    durationMs: now.getTime() - new Date(expedition.startedAt).getTime(),
    loot: [...expedition.carriedLoot],
    gold: expedition.carriedGold,
    xp: expedition.carriedXp,
    materials: expedition.carriedMaterials,
    events: [...expedition.events]
  }

  save.activeExpeditions = save.activeExpeditions.filter((activeExpedition) => activeExpedition.id !== expedition.id)
  save.expeditionHistory = [summary, ...save.expeditionHistory].slice(0, EXPEDITION_HISTORY_LIMIT)
}

function generateExpeditionEvent(save: SaveGame, expedition: ActiveExpedition, quest: Quest, now: Date, skipPortal = false): ExpeditionEvent {
  const type = skipPortal ? pickExpeditionEventType(expedition, true) : pickExpeditionEventType(expedition)
  let title = ''
  let description = ''
  let damageTaken: number | undefined
  let xpGained: number | undefined
  let goldFound: number | undefined
  let lootFound: Item[] | undefined
  let depthGained: number | undefined
  let materialsFound: number | undefined

  if (type === 'enemy') {
    title = 'Enemy Encounter'
    description = 'The party encountered hostile forces.'
    damageTaken = Math.floor(Math.random() * 10) + 5
    xpGained = Math.floor(Math.random() * 15) + 5
    if (Math.random() < 0.3) goldFound = Math.floor(Math.random() * 10) + 5
  } else if (type === 'treasure') {
    title = 'Treasure Found'
    description = 'The party discovered a hidden cache.'
    goldFound = Math.floor(Math.random() * 20) + 10
    materialsFound = Math.floor(Math.random() * 4) + 1
    if (Math.random() < 0.4) lootFound = [generateItem(quest.lootTableId, 0)]
  } else if (type === 'trap') {
    title = 'Trap Triggered'
    description = 'The party triggered a dangerous trap.'
    damageTaken = Math.floor(Math.random() * 15) + 10
  } else if (type === 'rest') {
    title = 'Safe Haven'
    description = 'The party found a place to rest and recover.'
  } else if (type === 'champion') {
    title = 'Champion Encounter'
    description = 'A powerful champion blocked the party\'s path.'
    damageTaken = Math.floor(Math.random() * 20) + 15
    xpGained = Math.floor(Math.random() * 25) + 15
    materialsFound = Math.floor(Math.random() * 6) + 2
    if (Math.random() < 0.5) goldFound = Math.floor(Math.random() * 15) + 10
    if (Math.random() < 0.3) lootFound = [generateItem(quest.lootTableId, 5)]
  } else if (type === 'evilHero') {
    title = 'Evil Hero Encounter'
    description = 'A fallen hero corrupted by darkness ambushed the party.'
    damageTaken = Math.floor(Math.random() * 25) + 20
    xpGained = Math.floor(Math.random() * 30) + 20
    materialsFound = Math.floor(Math.random() * 8) + 3
    if (Math.random() < 0.4) goldFound = Math.floor(Math.random() * 20) + 15
    if (Math.random() < 0.4) lootFound = [generateItem(quest.lootTableId, 10)]
  } else if (type === 'bossClue') {
    title = 'Boss Clue Found'
    description = 'The party discovered evidence of the boss\'s presence.'
    depthGained = Math.floor(Math.random() * 10) + 5
    materialsFound = Math.floor(Math.random() * 5) + 2
  } else if (type === 'boss') {
    title = 'Boss Encounter'
    description = 'The party has reached the boss chamber!'
    damageTaken = Math.floor(Math.random() * 30) + 20
    xpGained = Math.floor(Math.random() * 50) + 30
    materialsFound = Math.floor(Math.random() * 15) + 5
    if (Math.random() < 0.6) goldFound = Math.floor(Math.random() * 50) + 25
    if (Math.random() < 0.5) lootFound = [generateItem(quest.lootTableId, 15)]
    expedition.bossDefeated = true
  } else if (type === 'portal') {
    title = 'Portal to Camp'
    description = 'The party discovered a temporary portal back to camp. It will last 30 seconds.'
  } else {
    title = 'Wandering Merchant'
    description = 'The party met a wandering trader with rare goods.'
    if (Math.random() < 0.5) goldFound = Math.floor(Math.random() * 30) + 10
    materialsFound = Math.floor(Math.random() * 5) + 1
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
    depthGained,
    materialsFound
  }
}

function applyExpeditionEvent(save: SaveGame, expedition: ActiveExpedition, event: ExpeditionEvent): void {
  const BASE_DEATH_CHANCE = 0.08
  const deathReduction = getDeathChanceReduction(save)
  const effectiveDeathChance = Math.max(0, BASE_DEATH_CHANCE - deathReduction)

  if (event.damageTaken !== undefined) {
    const livingStates = expedition.partyState.filter((state) => !state.dead)
    const damagePerHero = livingStates.length ? Math.max(1, Math.floor(event.damageTaken / livingStates.length)) : 0
    for (const state of livingStates) {
      state.temporaryHp = Math.max(0, state.temporaryHp - damagePerHero)
      if (state.temporaryHp <= 0) {
        state.dead = true
        if (Math.random() < effectiveDeathChance) {
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

  if (event.type === 'portal') {
    expedition.portalAvailableUntil = new Date(new Date(event.createdAt).getTime() + 30000).toISOString()
    expedition.portalEventId = event.id
    return
  }

  if (event.type === 'rest') {
    const healAmount = Math.floor(20 + Math.random() * 20)
    for (const state of expedition.partyState) {
      if (!state.dead) {
        state.temporaryHp = Math.min(state.maxTemporaryHp, state.temporaryHp + healAmount)
      }
    }
  }

  if (event.xpGained !== undefined) expedition.carriedXp += event.xpGained
  if (event.goldFound !== undefined) expedition.carriedGold += event.goldFound
  if (event.materialsFound !== undefined) expedition.carriedMaterials += event.materialsFound
  if (event.lootFound?.length) expedition.carriedLoot.push(...event.lootFound)
  if (event.depthGained !== undefined) expedition.depth += event.depthGained
}

// --- Private helpers ---

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

function pickExpeditionEventType(expedition: ActiveExpedition, forceNoPortal = false): Exclude<ExpeditionEvent['type'], 'death' | 'return'> {
  const danger = Math.min(1, expedition.depth / 100)
  const portalActive = expedition.portalAvailableUntil !== undefined && expedition.portalAvailableUntil !== null
  const portalWeight = (forceNoPortal || expedition.status !== 'exploring' || portalActive) ? 0 : 4
  const weights: Array<[Exclude<ExpeditionEvent['type'], 'death' | 'return'>, number]> = [
    ['enemy', 36 + danger * 10],
    ['treasure', 20],
    ['trap', 10 + danger * 8],
    ['rest', Math.max(4, 10 - danger * 5)],
    ['champion', 8 + danger * 5],
    ['evilHero', 5 + danger * 4],
    ['bossClue', expedition.bossReady ? 0 : 5],
    ['boss', expedition.bossReady && !expedition.bossDefeated ? 12 : 0],
    ['portal', portalWeight]
  ]
  const totalWeight = weights.reduce((sum, [, weight]) => sum + weight, 0)
  let roll = Math.random() * totalWeight
  for (const [type, weight] of weights) {
    roll -= weight
    if (roll <= 0) return type
  }
  return 'enemy'
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
