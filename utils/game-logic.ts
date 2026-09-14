import type { AppraisalJob, CaravanUpgradeId, ItemRarity, SaveGame } from '~/types/game'
import type { UnavailableReason } from '~/shared/types/v2-game-view'
import { V2DomainRuleError } from '~/shared/errors/v2-domain'
import { appraiserQueueSizes, caravanUpgradeCosts, quests, stashCapacities } from '~/utils/game-data'
import { createStarterItems, createVisitRound, normalizeVisitorDetails, refreshVisitRound } from '~/utils/visitor-logic'

export const SAVE_SCHEMA_VERSION = 3
export const LEGACY_SAVE_FIELDS = [
  'materials', 'heroes', 'pendingLoot', 'questsProgress', 'activeQuestRun',
  'lastQuestRun', 'activeExpedition', 'activeExpeditions', 'lastExpeditionRun', 'expeditionHistory'
] as const
const rarePrefixes = ['Storm', 'Blood', 'Dread', 'Rune', 'Grim', 'Havoc']
const rareSuffixes = ['Loop', 'Grasp', 'Shelter', 'Song', 'Brand', 'Guard']

export function createSaveGame(userId: string, nowDate = new Date(), random = Math.random): SaveGame {
  const now = nowDate.toISOString()
  const save: SaveGame = {
    schemaVersion: SAVE_SCHEMA_VERSION,
    userId,
    gold: 450,
    caravan: {
      level: 0,
      upgrades: { stashWagon: 0, appraiser: 0 },
      services: { appraiserQueue: [] }
    },
    stashLimit: stashCapacities[0],
    stash: createStarterItems(random),
    unlockedRegionIds: [quests[0]?.id ?? 'blood-moor'],
    visitRound: undefined as never,
    visitHistory: [],
    processedRequestIds: [],
    processedRequests: [],
    revision: 0,
    createdAt: now,
    updatedAt: now
  }
  save.visitRound = createVisitRound(save, 1, nowDate, random)
  return save
}

export function normalizeSaveGame(save: SaveGame, options: { refreshVisitors?: boolean } = {}): SaveGame {
  if (save?.schemaVersion !== SAVE_SCHEMA_VERSION) return createSaveGame(requireUserId(save))

  const rawSave = save as SaveGame & Record<string, unknown>
  for (const field of LEGACY_SAVE_FIELDS) delete rawSave[field]

  if (!Number.isInteger(save.revision) || save.revision < 0) save.revision = 0
  if (!Array.isArray(save.processedRequestIds)) save.processedRequestIds = []
  if (!Array.isArray(save.processedRequests)) {
    save.processedRequests = save.processedRequestIds.map((requestId) => ({ requestId, operationKey: '' }))
  }
  if (!Array.isArray(save.visitHistory)) save.visitHistory = []
  save.visitHistory = save.visitHistory.filter((round) => Array.isArray(round?.slots))
  if (!Array.isArray(save.stash)) save.stash = []
  if (!Array.isArray(save.unlockedRegionIds) || save.unlockedRegionIds.length === 0) {
    save.unlockedRegionIds = [quests[0]?.id ?? 'blood-moor']
  }
  if (!save.caravan || typeof save.caravan !== 'object') {
    save.caravan = { level: 0, upgrades: { stashWagon: 0, appraiser: 0 }, services: { appraiserQueue: [] } }
  }
  save.caravan.level = nonNegativeInteger(save.caravan.level)
  save.caravan.upgrades = {
    stashWagon: clampedLevel(save.caravan.upgrades?.stashWagon),
    appraiser: clampedLevel(save.caravan.upgrades?.appraiser)
  }
  if (!save.caravan.services || !Array.isArray(save.caravan.services.appraiserQueue)) {
    save.caravan.services = { appraiserQueue: [] }
  }
  save.stashLimit = Math.max(stashCapacities[save.caravan.upgrades.stashWagon] ?? stashCapacities[0], Number(save.stashLimit) || 0)
  if (!save.visitRound || !Array.isArray(save.visitRound.slots)) save.visitRound = createVisitRound(save, 1)
  normalizeVisitorDetails(save)
  if (options.refreshVisitors !== false) refreshVisitRound(save)
  return save
}

export function getStashCapacity(save: SaveGame): number {
  return stashCapacities[clampedLevel(save.caravan.upgrades.stashWagon)]
}

export function getAppraiserQueueSize(save: SaveGame): number {
  return appraiserQueueSizes[clampedLevel(save.caravan.upgrades.appraiser)]
}

export function getUpgradeCost(upgradeId: CaravanUpgradeId, level: number): { gold: number } | null {
  return caravanUpgradeCosts[upgradeId]?.[level + 1] ?? null
}

export function getMaxUpgradeLevel(upgradeId: CaravanUpgradeId): number {
  return caravanUpgradeCosts[upgradeId].length - 1
}

export function upgradeCaravan(save: SaveGame, upgradeId: CaravanUpgradeId, now = new Date()): SaveGame {
  save = normalizeSaveGame(save, { refreshVisitors: false })
  const currentLevel = save.caravan.upgrades[upgradeId]
  if (currentLevel >= getMaxUpgradeLevel(upgradeId)) throw gameError('Upgrade is already at max level', 'TERMINAL_ENTITY')
  const cost = getUpgradeCost(upgradeId, currentLevel)
  if (!cost) throw gameError('Upgrade cost not found')
  if (save.gold < cost.gold) throw gameError('Not enough gold')

  save.gold -= cost.gold
  save.caravan.upgrades[upgradeId] = currentLevel + 1
  save.caravan.level = Math.max(save.caravan.level, currentLevel + 1)
  save.stashLimit = getStashCapacity(save)
  return touchSave(save, now)
}

export function startAppraisal(save: SaveGame, itemId: string, now = new Date(), uuid = randomId): SaveGame {
  save = normalizeSaveGame(save, { refreshVisitors: false })
  const queueSize = getAppraiserQueueSize(save)
  if (queueSize <= 0) throw gameError('Appraiser not available. Upgrade your caravan.', 'SERVICE_LOCKED')
  const item = save.stash.find((entry) => entry.id === itemId)
  if (!item) throw gameError('Item not found in stash', 'ITEM_NOT_OWNED')
  if (item.identified) throw gameError('Item is already identified', 'OPTION_STALE')
  if (save.caravan.services.appraiserQueue.some((job) => job.itemId === itemId)) throw gameError('Item is already in the appraiser queue', 'ITEM_IN_USE')
  if (save.caravan.services.appraiserQueue.length >= queueSize) throw gameError('Appraiser queue is full', 'CAPACITY_FULL')

  const durationMinutes = item.rarity === 'magic' ? 5 : item.rarity === 'rare' ? 15 : item.rarity === 'unique' ? 30 : 0
  if (durationMinutes <= 0) throw gameError('Item does not need appraisal', 'OPTION_STALE')
  const job: AppraisalJob = {
    id: uuid(),
    itemId,
    startedAt: now.toISOString(),
    finishesAt: new Date(now.getTime() + durationMinutes * 60_000).toISOString()
  }
  save.caravan.services.appraiserQueue.push(job)
  return touchSave(save, now)
}

export function completeAppraisalQueue(save: SaveGame, now = new Date(), random = Math.random): SaveGame {
  save = normalizeSaveGame(save, { refreshVisitors: false })
  const remaining: AppraisalJob[] = []
  for (const job of save.caravan.services.appraiserQueue) {
    if (new Date(job.finishesAt).getTime() > now.getTime()) {
      remaining.push(job)
      continue
    }
    const item = save.stash.find((entry) => entry.id === job.itemId)
    if (item && !item.identified) identifyWithoutCost(item, random)
  }
  save.caravan.services.appraiserQueue = remaining
  return touchSave(save, now)
}

export function identifyItem(save: SaveGame, itemId: string, random = Math.random, now = new Date()): SaveGame {
  save = normalizeSaveGame(save, { refreshVisitors: false })
  const item = save.stash.find((entry) => entry.id === itemId)
  if (!item) throw gameError('Item not found in stash', 'ITEM_NOT_OWNED')
  if (save.caravan.services.appraiserQueue.some((job) => job.itemId === itemId)) {
    throw gameError('Item is already in the appraiser queue', 'ITEM_IN_USE')
  }
  if (item.identified) return save
  const cost = identifyCost(item.rarity)
  if (save.gold < cost) throw gameError('Not enough gold')
  save.gold -= cost
  identifyWithoutCost(item, random)
  return touchSave(save, now)
}

export function identifyCost(rarity: ItemRarity): number {
  if (rarity === 'magic') return 50
  if (rarity === 'rare') return 110
  if (rarity === 'unique') return 200
  return 0
}

export function touchSave(save: SaveGame, now = new Date()): SaveGame {
  save.updatedAt = now.toISOString()
  return save
}

function identifyWithoutCost(item: SaveGame['stash'][number], random = Math.random): void {
  item.identified = true
  if (item.rarity === 'rare') item.displayName = `${pick(rarePrefixes, random)} ${pick(rareSuffixes, random)}`
}

function requireUserId(value: unknown): string {
  if (!value || typeof value !== 'object' || typeof (value as { userId?: unknown }).userId !== 'string') {
    throw gameError('Save is missing userId')
  }
  return (value as { userId: string }).userId
}

function nonNegativeInteger(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

function clampedLevel(value: unknown): 0 | 1 | 2 | 3 {
  return Math.min(3, nonNegativeInteger(value)) as 0 | 1 | 2 | 3
}

function pick<T>(values: T[], random = Math.random): T {
  const value = values[Math.floor(random() * values.length)]
  if (value === undefined) throw gameError('Cannot choose from an empty collection')
  return value
}

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

class GameDomainError extends V2DomainRuleError {
  override name = 'GameDomainError'
}

function gameError(message: string, unavailableReason?: UnavailableReason): GameDomainError {
  return new GameDomainError(message, unavailableReason)
}
