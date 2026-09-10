import type {
  CommissionOption,
  CommissionOutcome,
  HeroClass,
  Item,
  ItemType,
  SaveGame,
  VisitRound,
  Visitor
} from '~/types/game'
import { itemBases, quests } from '~/utils/game-data'

export type RandomSource = () => number

export class VisitorDomainError extends Error {
  override name = 'VisitorDomainError'
}

export const MAX_ACTIVE_COMMISSIONS = 2
export const VISIT_HISTORY_LIMIT = 20
const VISITOR_COUNT = 2
const allItemTypes: ItemType[] = ['weapon', 'armor', 'helmet', 'gloves', 'boots', 'ring', 'amulet', 'charm']
const visitorNames = ['Mira', 'Torvald', 'Ysra', 'Kael', 'Nahla', 'Bram', 'Vesper', 'Orin']
const visitorClasses: HeroClass[] = ['barbarian', 'sorceress', 'paladin', 'necromancer']

export function createStarterItems(random: RandomSource = Math.random): Item[] {
  return [starterItem(0, random), starterItem(6, random)]
}

export function createVisitRound(
  save: Pick<SaveGame, 'gold' | 'stash' | 'stashLimit' | 'questsProgress'>,
  roundNumber: number,
  now = new Date(),
  random: RandomSource = Math.random
): VisitRound {
  const visitors = Array.from({ length: VISITOR_COUNT }, () => createVisitor(save, now, random))
  ensureViableRound(save, visitors, random)
  return {
    id: randomId(random),
    number: roundNumber,
    visitors,
    createdAt: now.toISOString()
  }
}

export function refreshVisitRound(save: SaveGame, now = new Date()): SaveGame {
  for (const visitor of save.visitRound.visitors) {
    if (visitor.state === 'commissioned' && visitor.commission && new Date(visitor.commission.finishesAt).getTime() <= now.getTime()) {
      visitor.state = 'returned'
      visitor.commission.status = 'ready'
      const result = resolveOutcome(visitor.commission.outcomeRoll, visitor.commission.successChance)
      visitor.commission.outcome = result
      visitor.commission.rewardGold = result === 'complete'
        ? visitor.commission.fullRewardGold
        : result === 'partial' ? visitor.commission.partialRewardGold : 0
    }
  }
  return save
}

export function buyFromVisitor(save: SaveGame, visitorId: string, offerId: string, requestId: string, now = new Date()): SaveGame {
  const visitor = requireTradeableVisitor(save, visitorId)
  const offer = visitor.offers.find((entry) => entry.id === offerId)
  if (!offer) throw domainError('Offer not found')
  if (offer.purchasedAt) throw domainError('Offer was already purchased')
  if (save.gold < offer.price) throw domainError('Not enough gold')
  if (save.stash.length >= save.stashLimit) throw domainError('Stash is full')

  save.gold -= offer.price
  visitor.budget += offer.price
  offer.purchasedAt = now.toISOString()
  save.stash.push(cloneItem(offer.item))
  visitor.trades.push({ requestId, kind: 'player_bought', itemId: offer.item.id, price: offer.price, createdAt: now.toISOString() })
  visitor.state = 'traded'
  return touch(save, now)
}

export function sellToVisitor(save: SaveGame, visitorId: string, itemId: string, requestId: string, now = new Date()): SaveGame {
  const visitor = requireTradeableVisitor(save, visitorId)
  const itemIndex = save.stash.findIndex((item) => item.id === itemId)
  if (itemIndex < 0) throw domainError('Item not found in stash')
  const item = save.stash[itemIndex]!
  if (!item.identified) throw domainError('Item must be identified before a visitor can buy it')
  if (!visitor.acceptedItemTypes.includes(item.type)) throw domainError('Visitor is not interested in this item type')
  const price = visitor.buyQuotes[itemId]
  if (typeof price !== 'number' || !Number.isInteger(price) || price <= 0) throw domainError('No persisted quote for this item')
  if (visitor.budget < price) throw domainError('Visitor cannot afford this item')

  save.stash.splice(itemIndex, 1)
  save.gold += price
  visitor.budget -= price
  visitor.trades.push({ requestId, kind: 'player_sold', itemId, price, createdAt: now.toISOString() })
  visitor.state = 'traded'
  if (isUsefulToVisitor(visitor, item)) {
    visitor.power += itemPower(item)
    visitor.commissionOptions = visitor.commissionOptions.map((option) => ({
      ...option,
      successChance: calculateCommissionChance(visitor.power, option.regionId)
    }))
  }
  return touch(save, now)
}

export function assignVisitorCommission(
  save: SaveGame,
  visitorId: string,
  regionId: string,
  random: RandomSource = Math.random,
  now = new Date()
): SaveGame {
  refreshVisitRound(save, now)
  const visitor = findVisitor(save, visitorId)
  if (visitor.state !== 'traded') throw domainError('Visitor must complete a trade before accepting a commission')
  const activeCount = save.visitRound.visitors.filter((entry) => entry.commission && entry.commission.status !== 'claimed').length
  if (activeCount >= MAX_ACTIVE_COMMISSIONS) throw domainError('Active commission limit reached')
  const option = visitor.commissionOptions.find((entry) => entry.regionId === regionId)
  if (!option) throw domainError('Region is not available for this visitor')

  visitor.commission = {
    ...option,
    id: randomId(random),
    status: 'active',
    startedAt: now.toISOString(),
    finishesAt: new Date(now.getTime() + option.durationMs).toISOString(),
    outcomeRoll: clampRandom(random())
  }
  visitor.state = 'commissioned'
  return touch(save, now)
}

export function claimVisitorCommission(save: SaveGame, visitorId: string, now = new Date(), random: RandomSource = Math.random): SaveGame {
  refreshVisitRound(save, now)
  const visitor = findVisitor(save, visitorId)
  const commission = visitor.commission
  if (!commission || visitor.state !== 'returned' || commission.status !== 'ready') throw domainError('Commission is not ready to claim')

  const rewardGold = commission.rewardGold ?? 0
  save.gold += rewardGold
  if (commission.outcome === 'complete' && save.stash.length < save.stashLimit) {
    commission.rewardItem = createOfferItem(random)
    save.stash.push(cloneItem(commission.rewardItem))
  }
  commission.status = 'claimed'
  commission.claimedAt = now.toISOString()
  visitor.state = 'departed'
  visitor.departedAt = now.toISOString()
  maybeAdvanceRound(save, now, random)
  return touch(save, now)
}

export function dismissVisitor(save: SaveGame, visitorId: string, now = new Date(), random: RandomSource = Math.random): SaveGame {
  refreshVisitRound(save, now)
  const visitor = findVisitor(save, visitorId)
  if (visitor.state === 'commissioned' || visitor.state === 'returned') throw domainError('Commission must be claimed before the visitor can leave')
  if (visitor.state === 'departed') throw domainError('Visitor has already departed')
  visitor.state = 'departed'
  visitor.departedAt = now.toISOString()
  maybeAdvanceRound(save, now, random)
  return touch(save, now)
}

export function salvageItem(save: SaveGame, itemId: string, now = new Date()): SaveGame {
  const itemIndex = save.stash.findIndex((item) => item.id === itemId)
  if (itemIndex < 0) throw domainError('Item not found in stash')
  const [item] = save.stash.splice(itemIndex, 1)
  save.gold += Math.max(1, Math.floor(item!.value * 0.25))
  return touch(save, now)
}

export function hasCommercialAction(save: Pick<SaveGame, 'gold' | 'stash' | 'stashLimit' | 'visitRound'>): boolean {
  return save.visitRound.visitors.some((visitor) => {
    if (visitor.state !== 'open') return false
    const canBuy = save.stash.length < save.stashLimit && visitor.offers.some((offer) => !offer.purchasedAt && offer.price <= save.gold)
    const canSell = save.stash.some((item) => {
      const quote = visitor.buyQuotes[item.id]
      return item.identified
        && visitor.acceptedItemTypes.includes(item.type)
        && typeof quote === 'number'
        && Number.isInteger(quote)
        && quote > 0
        && quote <= visitor.budget
    })
    return canBuy || canSell
  })
}

function createVisitor(save: Pick<SaveGame, 'stash' | 'questsProgress'>, now: Date, random: RandomSource): Visitor {
  const acceptedItemTypes = sampleDistinct(allItemTypes, 4, random)
  const interestedItemTypes = acceptedItemTypes.slice(0, 2)
  const level = randomInt(1, 7, random)
  const visitor: Visitor = {
    id: randomId(random),
    name: pick(visitorNames, random),
    class: pick(visitorClasses, random),
    level,
    state: 'open',
    budget: randomInt(140, 420, random),
    initialBudget: 0,
    acceptedItemTypes,
    interestedItemTypes,
    offers: Array.from({ length: 2 }, () => {
      const item = createOfferItem(random)
      return { id: randomId(random), item, price: percentage(item.value, 0.90, 1.25, random) }
    }),
    buyQuotes: {},
    trades: [],
    power: 42 + level * 9,
    commissionOptions: [],
    arrivedAt: now.toISOString()
  }
  visitor.initialBudget = visitor.budget
  for (const item of save.stash) {
    if (!item.identified || !acceptedItemTypes.includes(item.type)) continue
    visitor.buyQuotes[item.id] = interestedItemTypes.includes(item.type)
      ? percentage(item.value, 0.80, 1.10, random)
      : percentage(item.value, 0.40, 0.60, random)
  }
  visitor.commissionOptions = unlockedCommissionOptions(save.questsProgress, visitor.power)
  return visitor
}

function ensureViableRound(save: Pick<SaveGame, 'gold' | 'stash' | 'stashLimit'>, visitors: Visitor[], random: RandomSource): void {
  const first = visitors[0]!
  const sellable = save.stash.find((item) => item.identified)
  if (sellable) {
    if (!first.acceptedItemTypes.includes(sellable.type)) first.acceptedItemTypes[0] = sellable.type
    if (!first.interestedItemTypes.includes(sellable.type)) first.interestedItemTypes[0] = sellable.type
    const quote = percentage(sellable.value, 0.80, 1.10, random)
    first.buyQuotes[sellable.id] = quote
    first.budget = Math.max(first.budget, quote)
    first.initialBudget = first.budget
    return
  }
  if (save.stash.length < save.stashLimit && save.gold > 0) {
    const item = starterItem(0, random)
    const price = percentage(item.value, 0.90, 1.25, random)
    if (price <= save.gold) {
      first.offers[0] = { id: randomId(random), item, price }
      return
    }
  }
  // Compatibility/soft-lock recovery for legacy saves with no usable assets.
  const reliefItem = starterItem(3, random)
  save.stash.push(reliefItem)
  if (!first.acceptedItemTypes.includes(reliefItem.type)) first.acceptedItemTypes[0] = reliefItem.type
  if (!first.interestedItemTypes.includes(reliefItem.type)) first.interestedItemTypes[0] = reliefItem.type
  const quote = percentage(reliefItem.value, 0.80, 1.10, random)
  first.buyQuotes[reliefItem.id] = quote
  first.budget = Math.max(first.budget, quote)
  first.initialBudget = first.budget
}

function unlockedCommissionOptions(progress: SaveGame['questsProgress'], power: number): CommissionOption[] {
  return quests.filter((quest) => progress.some((entry) => entry.questId === quest.id && entry.unlocked)).map((quest) => ({
    regionId: quest.id,
    durationMs: 60_000 + quest.difficulty * 2_000,
    successChance: calculateCommissionChance(power, quest.id),
    fullRewardGold: Math.round(quest.rewards.gold * 0.75),
    partialRewardGold: Math.round(quest.rewards.gold * 0.25)
  }))
}

function calculateCommissionChance(power: number, regionId: string): number {
  const difficulty = quests.find((quest) => quest.id === regionId)?.difficulty ?? 100
  return roundTo(Math.max(0.10, Math.min(0.90, power / (power + difficulty))), 3)
}

function resolveOutcome(roll: number, chance: number): CommissionOutcome {
  if (roll <= chance) return 'complete'
  if (roll <= Math.min(0.97, chance + 0.25)) return 'partial'
  return 'failed'
}

function maybeAdvanceRound(save: SaveGame, now: Date, random: RandomSource): void {
  if (!save.visitRound.visitors.every((visitor) => visitor.state === 'departed')) return
  save.visitHistory.unshift(save.visitRound)
  save.visitHistory = save.visitHistory.slice(0, VISIT_HISTORY_LIMIT)
  save.visitRound = createVisitRound(save, save.visitRound.number + 1, now, random)
}

function requireTradeableVisitor(save: SaveGame, visitorId: string): Visitor {
  const visitor = findVisitor(save, visitorId)
  if (visitor.state !== 'open') throw domainError('Visitor is no longer available for trade')
  return visitor
}

function findVisitor(save: SaveGame, visitorId: string): Visitor {
  const visitor = save.visitRound.visitors.find((entry) => entry.id === visitorId)
  if (!visitor) throw domainError('Visitor not found in current round')
  return visitor
}

function isUsefulToVisitor(visitor: Visitor, item: Item): boolean {
  const classPreference: Record<HeroClass, ItemType[]> = {
    barbarian: ['weapon', 'armor', 'helmet'],
    sorceress: ['weapon', 'ring', 'amulet'],
    paladin: ['weapon', 'armor', 'helmet'],
    necromancer: ['weapon', 'ring', 'amulet']
  }
  return item.identified && item.requiredLevel <= visitor.level && classPreference[visitor.class].includes(item.type)
}

function itemPower(item: Item): number {
  return Math.max(2, Math.round(item.affixes.reduce((sum, affix) => sum + affix.value, 0) * 0.25 + item.value * 0.04))
}

function starterItem(index: number, random: RandomSource): Item {
  const base = itemBases[index] ?? itemBases[0]!
  return {
    id: randomId(random),
    baseName: base.baseName,
    displayName: base.baseName,
    type: base.type,
    rarity: 'normal',
    identified: true,
    width: base.width,
    height: base.height,
    requiredLevel: base.requiredLevel,
    affixes: [...(base.implicit ?? [])],
    value: base.value
  }
}

function createOfferItem(random: RandomSource): Item {
  return starterItem(randomInt(0, itemBases.length - 1, random), random)
}

function cloneItem(item: Item): Item {
  return { ...item, affixes: item.affixes.map((affix) => ({ ...affix })), position: item.position ? { ...item.position } : undefined }
}

function percentage(value: number, min: number, max: number, random: RandomSource): number {
  return Math.max(1, Math.round(value * (min + clampRandom(random()) * (max - min))))
}

function randomInt(min: number, max: number, random: RandomSource): number {
  return Math.floor(clampRandom(random()) * (max - min + 1)) + min
}

function pick<T>(values: readonly T[], random: RandomSource): T {
  return values[Math.min(values.length - 1, Math.floor(clampRandom(random()) * values.length))]!
}

function sampleDistinct<T>(values: readonly T[], count: number, random: RandomSource): T[] {
  const pool = [...values]
  const result: T[] = []
  while (pool.length && result.length < count) result.push(pool.splice(randomInt(0, pool.length - 1, random), 1)[0]!)
  return result
}

function clampRandom(value: number): number {
  return Math.max(0, Math.min(0.999999999, value))
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function randomId(random: RandomSource): string {
  return `${Date.now().toString(36)}-${Math.floor(clampRandom(random()) * 0xFFFFFFFF).toString(36).padStart(7, '0')}`
}

function touch(save: SaveGame, now: Date): SaveGame {
  save.updatedAt = now.toISOString()
  return save
}

function domainError(message: string): VisitorDomainError {
  return new VisitorDomainError(message)
}
