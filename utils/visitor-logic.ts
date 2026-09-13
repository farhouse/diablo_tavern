import type {
  CommissionOption,
  CommissionOutcome,
  HeroClass,
  Item,
  ItemType,
  SaveGame,
  VisitRound,
  Visitor,
  VisitorEquipmentSummaryItem
} from '~/types/game'
import { affixPool, itemBases, quests, uniqueItems } from '~/utils/game-data'

export type RandomSource = () => number

export class VisitorDomainError extends Error {
  override name = 'VisitorDomainError'
}

export const MAX_ACTIVE_COMMISSIONS = 2
export const VISIT_HISTORY_LIMIT = 20
export const VISITOR_CONFIG = {
  slotCount: 2,
  arrivalCheckIntervalMs: 30_000,
  arrivalChancePerCheck: 0.4,
  commissions: {
    safe: { durationMultiplier: 0.75, chanceDelta: 0.15, fullRewardMultiplier: 0.6, partialRewardMultiplier: 0.2 },
    risky: { durationMultiplier: 1.75, chanceDelta: -0.15, fullRewardMultiplier: 1.35, partialRewardMultiplier: 0.35 }
  }
} as const

export function effectiveCaravanCapacityUsed(save: Pick<SaveGame, 'stash' | '_effectiveCapacityUsed'>): number {
  return save._effectiveCapacityUsed ?? save.stash.length
}
const allItemTypes: ItemType[] = ['weapon', 'armor', 'helmet', 'gloves', 'boots', 'ring', 'amulet', 'charm']
const visitorNames = ['Mira', 'Torvald', 'Ysra', 'Kael', 'Nahla', 'Bram', 'Vesper', 'Orin']
const visitorClasses: HeroClass[] = ['barbarian', 'sorceress', 'paladin', 'necromancer']
const visitorOrigins = ['Ashen Foothills', 'Black Marsh', 'Iron Highlands', 'Forgotten Coast', 'Dustbound Vale', 'Silverwood']
const arrivalEquipment: Record<HeroClass, Omit<VisitorEquipmentSummaryItem, 'powerBonus'>> = {
  barbarian: { name: 'Worn battle axe', type: 'weapon' },
  sorceress: { name: 'Travel-stained focus', type: 'amulet' },
  paladin: { name: 'Dented field plate', type: 'armor' },
  necromancer: { name: 'Bone-carved wand', type: 'weapon' }
}

export function createStarterItems(random: RandomSource = Math.random): Item[] {
  return [starterItem(0, random), starterItem(6, random)]
}

export function createVisitRound(
  save: Pick<SaveGame, 'gold' | 'stash' | 'stashLimit' | 'unlockedRegionIds'>,
  roundNumber: number,
  now = new Date(),
  random: RandomSource = Math.random
): VisitRound {
  const visitors = Array.from({ length: VISITOR_CONFIG.slotCount }, () => createVisitor(save, now, random))
  ensureCommercialOpportunities(save, visitors, random)
  return {
    id: randomId(random),
    number: roundNumber,
    slots: visitors.map((visitor, index) => ({ id: `visitor-slot-${index + 1}`, visitor })),
    createdAt: now.toISOString()
  }
}

export function refreshVisitRound(save: SaveGame, now = new Date(), random: RandomSource = Math.random): SaveGame {
  for (const slot of save.visitRound.slots) {
    const visitor = slot.visitor
    if (!visitor && slot.nextArrivalCheckAt && new Date(slot.nextArrivalCheckAt).getTime() <= now.getTime()) {
      if (clampRandom(random()) < VISITOR_CONFIG.arrivalChancePerCheck) {
        const arrival = createVisitor(save, now, random)
        ensureCommercialOpportunities(save, [arrival], random)
        slot.visitor = arrival
        delete slot.nextArrivalCheckAt
        save.visitRound.number += 1
        save.visitRound.id = randomId(random)
        save.visitRound.createdAt = now.toISOString()
      } else {
        slot.nextArrivalCheckAt = nextArrivalCheck(now).toISOString()
      }
    }
    if (!visitor) continue
    if (visitor.state === 'commissioned' && visitor.commission && new Date(visitor.commission.finishesAt).getTime() <= now.getTime()) {
      visitor.state = 'returned'
      visitor.commission.status = 'ready'
      const result = resolveOutcome(visitor.commission.outcomeRoll, visitor.commission.successChance)
      visitor.commission.outcome = result
      visitor.commission.rewardGold = result === 'complete'
        ? visitor.commission.fullRewardGold
        : result === 'partial' ? visitor.commission.partialRewardGold : 0
      if (result === 'complete' && !visitor.commission.rewardItem
        && effectiveCaravanCapacityUsed(save) < save.stashLimit) {
        visitor.commission.rewardItem = createOfferItem(random)
        adjustEffectiveCapacity(save, 1)
      }
    }
  }
  return save
}

export function normalizeVisitorDetails(save: Pick<SaveGame, 'visitRound' | 'visitHistory' | 'unlockedRegionIds'>): void {
  for (const round of [save.visitRound, ...save.visitHistory]) {
    const isCurrentRound = round === save.visitRound
    while (round.slots.length < VISITOR_CONFIG.slotCount) {
      round.slots.push({
        id: `visitor-slot-${round.slots.length + 1}`,
        nextArrivalCheckAt: isCurrentRound ? nextArrivalCheck(safeDate(round.createdAt)).toISOString() : undefined
      })
    }
    round.slots = round.slots.slice(0, VISITOR_CONFIG.slotCount)
    for (const [index, slot] of round.slots.entries()) {
      if (typeof slot.id !== 'string' || !slot.id) slot.id = `visitor-slot-${index + 1}`
      if (isCurrentRound && slot.visitor?.state === 'departed') {
        const departedVisitor = slot.visitor
        normalizeVisitor(departedVisitor, save.unlockedRegionIds)
        if (!save.visitHistory.some((history) => history.slots?.some((entry) => entry.visitor?.id === departedVisitor.id))) {
          save.visitHistory.unshift({
            id: `${round.id}:${departedVisitor.id}`,
            number: round.number,
            slots: round.slots.map((entry) => entry.id === slot.id
              ? { id: entry.id, visitor: structuredClone(departedVisitor) }
              : { id: entry.id }),
            createdAt: departedVisitor.departedAt ?? round.createdAt
          })
        }
        slot.nextArrivalCheckAt = nextArrivalCheck(safeDate(departedVisitor.departedAt, round.createdAt)).toISOString()
        delete slot.visitor
      } else if (slot.visitor) {
        normalizeVisitor(slot.visitor, isCurrentRound ? save.unlockedRegionIds : [])
        delete slot.nextArrivalCheckAt
      } else if (isCurrentRound && !isValidDate(slot.nextArrivalCheckAt)) {
        slot.nextArrivalCheckAt = nextArrivalCheck(safeDate(round.createdAt)).toISOString()
      }
    }
  }
  save.visitHistory = save.visitHistory.slice(0, VISIT_HISTORY_LIMIT)
}

export function buyFromVisitor(save: SaveGame, visitorId: string, offerId: string, requestId: string, now = new Date()): SaveGame {
  const visitor = requireTradeableVisitor(save, visitorId)
  if (visitor.trades.some((trade) => trade.kind === 'player_bought')) throw domainError('Visitor already completed a sale to the player')
  const offer = visitor.offers.find((entry) => entry.id === offerId)
  if (!offer) throw domainError('Offer not found')
  if (offer.purchasedAt) throw domainError('Offer was already purchased')
  if (save.gold < offer.price) throw domainError('Not enough gold')
  if (effectiveCaravanCapacityUsed(save) >= save.stashLimit) throw domainError('Stash is full')

  save.gold -= offer.price
  visitor.budget += offer.price
  offer.purchasedAt = now.toISOString()
  save.stash.push({ ...cloneItem(offer.item), acquisitionCost: offer.price })
  adjustEffectiveCapacity(save, 1)
  visitor.trades.push({ requestId, kind: 'player_bought', itemId: offer.item.id, price: offer.price, createdAt: now.toISOString() })
  visitor.state = 'traded'
  return touch(save, now)
}

export function sellToVisitor(save: SaveGame, visitorId: string, itemId: string, requestId: string, now = new Date()): SaveGame {
  const visitor = requireTradeableVisitor(save, visitorId)
  if (visitor.trades.some((trade) => trade.kind === 'player_sold')) throw domainError('Visitor already completed a purchase from the player')
  const itemIndex = save.stash.findIndex((item) => item.id === itemId)
  if (itemIndex < 0) throw domainError('Item not found in stash')
  const item = save.stash[itemIndex]!
  if (!item.identified) throw domainError('Item must be identified before a visitor can buy it')
  if (!visitor.acceptedItemTypes.includes(item.type)) throw domainError('Visitor is not interested in this item type')
  const price = visitor.buyQuotes[itemId]
  if (typeof price !== 'number' || !Number.isInteger(price) || price <= 0) throw domainError('No persisted quote for this item')
  if (visitor.budget < price) throw domainError('Visitor cannot afford this item')

  save.stash.splice(itemIndex, 1)
  adjustEffectiveCapacity(save, -1)
  save.gold += price
  visitor.budget -= price
  visitor.trades.push({ requestId, kind: 'player_sold', itemId, price, createdAt: now.toISOString() })
  visitor.state = 'traded'
  if (isUsefulToVisitor(visitor, item)) {
    const powerBonus = itemPower(item)
    visitor.power += powerBonus
    visitor.equipmentSummary.push({
      itemId: item.id,
      name: item.displayName,
      type: item.type,
      powerBonus
    })
    visitor.commissionOptions = visitor.commissionOptions.map((option) => ({
      ...option,
      successChance: calculateOptionChance(visitor.power, option.regionId, option.optionId)
    }))
  }
  return touch(save, now)
}

export function assignVisitorCommission(
  save: SaveGame,
  visitorId: string,
  optionId: CommissionOption['optionId'],
  random: RandomSource = Math.random,
  now = new Date()
): SaveGame {
  refreshVisitRound(save, now, random)
  const visitor = findVisitor(save, visitorId)
  if (visitor.state !== 'traded') throw domainError('Visitor must complete a trade before accepting a commission')
  const activeCount = currentVisitors(save).filter((entry) => entry.commission && entry.commission.status !== 'claimed').length
  if (activeCount >= MAX_ACTIVE_COMMISSIONS) throw domainError('Active commission limit reached')
  const option = visitor.commissionOptions.find((entry) => entry.optionId === optionId)
  if (!option) throw domainError('Commission option is not available for this visitor')

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

export function claimVisitorCommission(save: SaveGame, visitorId: string, now = new Date()): SaveGame {
  const visitor = findVisitor(save, visitorId)
  const commission = visitor.commission
  if (!commission || visitor.state !== 'returned' || commission.status !== 'ready') throw domainError('Commission is not ready to claim')

  const rewardGold = commission.rewardGold ?? 0
  save.gold += rewardGold
  if (commission.outcome === 'complete') {
    if (commission.rewardItem) {
      if (!save.stash.some((item) => item.id === commission.rewardItem!.id)) save.stash.push(cloneItem(commission.rewardItem))
    }
  }
  commission.status = 'claimed'
  commission.claimedAt = now.toISOString()
  visitor.state = 'departed'
  visitor.departedAt = now.toISOString()
  archiveVisitor(save, visitor)
  releaseVisitorSlot(save, visitor.id, now)
  return touch(save, now)
}

export function dismissVisitor(save: SaveGame, visitorId: string, now = new Date(), random: RandomSource = Math.random): SaveGame {
  refreshVisitRound(save, now, random)
  const visitor = findVisitor(save, visitorId)
  if (visitor.state === 'commissioned' || visitor.state === 'returned') throw domainError('Commission must be claimed before the visitor can leave')
  if (visitor.state === 'departed') throw domainError('Visitor has already departed')
  visitor.state = 'departed'
  visitor.departedAt = now.toISOString()
  archiveVisitor(save, visitor)
  releaseVisitorSlot(save, visitor.id, now)
  return touch(save, now)
}

export function salvageItem(save: SaveGame, itemId: string, now = new Date()): SaveGame {
  if (save.caravan.services.appraiserQueue.some((job) => job.itemId === itemId)) {
    throw domainError('Item is in the appraiser queue')
  }
  const itemIndex = save.stash.findIndex((item) => item.id === itemId)
  if (itemIndex < 0) throw domainError('Item not found in stash')
  const [item] = save.stash.splice(itemIndex, 1)
  adjustEffectiveCapacity(save, -1)
  save.gold += Math.max(1, Math.floor(item!.value * 0.25))
  return touch(save, now)
}

export function hasCommercialAction(save: Pick<SaveGame, 'gold' | 'stash' | 'stashLimit' | 'visitRound' | '_effectiveCapacityUsed'>): boolean {
  return hasPurchaseAction(save) || hasSaleAction(save)
}

export function hasPurchaseAction(save: Pick<SaveGame, 'gold' | 'stash' | 'stashLimit' | 'visitRound' | '_effectiveCapacityUsed'>): boolean {
  return currentVisitors(save).some((visitor) => (visitor.state === 'open' || visitor.state === 'traded')
    && !visitor.trades.some((trade) => trade.kind === 'player_bought')
    && effectiveCaravanCapacityUsed(save) < save.stashLimit
    && visitor.offers.some((offer) => !offer.purchasedAt && offer.price <= save.gold))
}

export function hasSaleAction(save: Pick<SaveGame, 'gold' | 'stash' | 'stashLimit' | 'visitRound'>): boolean {
  return currentVisitors(save).some((visitor) => (visitor.state === 'open' || visitor.state === 'traded')
    && !visitor.trades.some((trade) => trade.kind === 'player_sold')
    && save.stash.some((item) => item.identified
      && visitor.acceptedItemTypes.includes(item.type)
      && typeof visitor.buyQuotes[item.id] === 'number'
      && Number.isInteger(visitor.buyQuotes[item.id])
      && visitor.buyQuotes[item.id]! > 0
      && visitor.buyQuotes[item.id]! <= visitor.budget))
}

function createVisitor(save: Pick<SaveGame, 'stash' | 'unlockedRegionIds'>, now: Date, random: RandomSource): Visitor {
  const acceptedItemTypes = sampleDistinct(allItemTypes, 4, random)
  const interestedItemTypes = acceptedItemTypes.slice(0, 2)
  const level = randomInt(1, 7, random)
  const id = randomId(random)
  const name = pick(visitorNames, random)
  const visitorClass = pick(visitorClasses, random)
  const startingEquipment = arrivalEquipment[visitorClass]
  const visitor: Visitor = {
    id,
    name,
    class: visitorClass,
    level,
    origin: visitorOrigins[stableIndex(id, visitorOrigins.length)]!,
    equipmentSummary: [{ ...startingEquipment, powerBonus: 0 }],
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
    const quote = interestedItemTypes.includes(item.type)
      ? percentage(item.value, 0.80, 1.10, random)
      : percentage(item.value, 0.40, 0.60, random)
    visitor.buyQuotes[item.id] = capQuoteForAcquisition(item, quote)
  }
  visitor.commissionOptions = unlockedCommissionOptions(save.unlockedRegionIds, visitor.power)
  return visitor
}

function normalizeVisitor(visitor: Visitor, unlockedRegionIds: SaveGame['unlockedRegionIds']): void {
  if (typeof visitor.origin !== 'string' || visitor.origin.trim().length === 0) {
    visitor.origin = visitorOrigins[stableIndex(visitor.id || visitor.name, visitorOrigins.length)]!
  }

  const startingEquipment = arrivalEquipment[visitor.class] ?? arrivalEquipment.barbarian
  visitor.equipmentSummary = Array.isArray(visitor.equipmentSummary)
    ? visitor.equipmentSummary.filter(isValidEquipmentSummaryItem)
    : []
  if (visitor.equipmentSummary.length === 0) {
    visitor.equipmentSummary.push({ ...startingEquipment, powerBonus: 0 })
  }
  const inferredPowerBonus = Math.max(0, visitor.power - (42 + visitor.level * 9))
  const summarizedPowerBonus = visitor.equipmentSummary.reduce((sum, item) => sum + item.powerBonus, 0)
  if (inferredPowerBonus > summarizedPowerBonus) {
    visitor.equipmentSummary.push({
      name: 'Equipment acquired at the tavern',
      type: visitor.interestedItemTypes[0] ?? startingEquipment.type,
      powerBonus: inferredPowerBonus - summarizedPowerBonus
    })
  }

  const regeneratedOptions = unlockedCommissionOptions(unlockedRegionIds, visitor.power, visitor.commissionOptions?.[0]?.regionId)
  if (!Array.isArray(visitor.commissionOptions)
    || visitor.commissionOptions.length !== 2
    || visitor.commissionOptions[0]?.optionId !== 'safe'
    || visitor.commissionOptions[1]?.optionId !== 'risky') {
    visitor.commissionOptions = regeneratedOptions
  }
  if (visitor.commission && (!visitor.commission.optionId || !visitor.commission.title || !visitor.commission.riskLevel || !visitor.commission.failureConsequence)) {
    const legacyCommission = visitor.commission as Visitor['commission'] & { optionId?: string }
    const replacement = regeneratedOptions[0]!
    legacyCommission.optionId = replacement.optionId
    legacyCommission.title = replacement.title
    legacyCommission.riskLevel = replacement.riskLevel
    legacyCommission.failureConsequence = replacement.failureConsequence
  }
}

function isValidEquipmentSummaryItem(value: unknown): value is VisitorEquipmentSummaryItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<VisitorEquipmentSummaryItem>
  return typeof item.name === 'string'
    && item.name.trim().length > 0
    && allItemTypes.includes(item.type as ItemType)
    && typeof item.powerBonus === 'number'
    && Number.isFinite(item.powerBonus)
    && item.powerBonus >= 0
    && (item.itemId === undefined || typeof item.itemId === 'string')
}

function stableIndex(value: string, length: number): number {
  let hash = 0
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return hash % length
}

function ensureCommercialOpportunities(save: Pick<SaveGame, 'gold' | 'stash' | 'stashLimit' | '_effectiveCapacityUsed'>, visitors: Visitor[], random: RandomSource): void {
  const first = visitors[0]!
  const cheapestOfferPrice = Math.min(...itemBases.map((base) => Math.round(base.value * 0.90)))
  let sellable = save.stash.find((item) => item.identified)
  if (!sellable && !itemBases.some((base) => Math.round(base.value * 0.90) <= save.gold)) {
    // Soft-lock recovery for a current save with no usable assets.
    if (effectiveCaravanCapacityUsed(save) >= save.stashLimit) {
      sellable = save.stash[0]
      if (sellable) sellable.identified = true
    } else {
      sellable = starterItem(3, random)
      save.stash.push(sellable)
      adjustEffectiveCapacity(save, 1)
    }
  }

  let guaranteedQuote = 0
  if (sellable) {
    if (!first.acceptedItemTypes.includes(sellable.type)) first.acceptedItemTypes[0] = sellable.type
    if (!first.interestedItemTypes.includes(sellable.type)) first.interestedItemTypes[0] = sellable.type
    const quotedPrice = percentage(sellable.value, 0.80, 1.10, random)
    const requiredForPurchase = Math.max(0, cheapestOfferPrice - save.gold)
    guaranteedQuote = capQuoteForAcquisition(
      sellable,
      Math.max(quotedPrice, Math.min(requiredForPurchase, Math.round(sellable.value * 1.10)))
    )
    first.buyQuotes[sellable.id] = guaranteedQuote
    first.budget = Math.max(first.budget, guaranteedQuote)
    first.initialBudget = first.budget
  }

  const purchasingPower = save.gold + guaranteedQuote
  const cheapestAffordableBaseIndex = itemBases.findIndex((base) => Math.round(base.value * 0.90) <= purchasingPower)
  if (cheapestAffordableBaseIndex >= 0) {
    const item = starterItem(cheapestAffordableBaseIndex, random)
    const price = Math.min(purchasingPower, Math.max(Math.round(item.value * 0.90), percentage(item.value, 0.90, 1.25, random)))
    first.offers[0] = { id: randomId(random), item, price }
  }
}

function adjustEffectiveCapacity(save: Pick<SaveGame, '_effectiveCapacityUsed'>, delta: number): void {
  if (save._effectiveCapacityUsed !== undefined) save._effectiveCapacityUsed += delta
}

function unlockedCommissionOptions(unlockedRegionIds: SaveGame['unlockedRegionIds'], power: number, fallbackRegionId?: string): CommissionOption[] {
  const unlocked = quests.filter((quest) => unlockedRegionIds.includes(quest.id))
  const quest = unlocked.sort((a, b) => b.difficulty - a.difficulty)[0]
    ?? quests.find((candidate) => candidate.id === fallbackRegionId)
    ?? quests[0]!
  const baseDuration = 60_000 + quest.difficulty * 2_000
  return [
    {
      optionId: 'safe', title: 'Careful patrol', regionId: quest.id,
      durationMs: Math.round(baseDuration * VISITOR_CONFIG.commissions.safe.durationMultiplier),
      successChance: calculateOptionChance(power, quest.id, 'safe'),
      fullRewardGold: Math.round(quest.rewards.gold * VISITOR_CONFIG.commissions.safe.fullRewardMultiplier),
      partialRewardGold: Math.round(quest.rewards.gold * VISITOR_CONFIG.commissions.safe.partialRewardMultiplier),
      riskLevel: 'low', failureConsequence: 'The slot stays occupied for the full duration and yields no reward.'
    },
    {
      optionId: 'risky', title: 'Perilous delve', regionId: quest.id,
      durationMs: Math.round(baseDuration * VISITOR_CONFIG.commissions.risky.durationMultiplier),
      successChance: calculateOptionChance(power, quest.id, 'risky'),
      fullRewardGold: Math.round(quest.rewards.gold * VISITOR_CONFIG.commissions.risky.fullRewardMultiplier),
      partialRewardGold: Math.round(quest.rewards.gold * VISITOR_CONFIG.commissions.risky.partialRewardMultiplier),
      riskLevel: 'high', failureConsequence: 'The slot stays occupied longer and a failure yields no reward.'
    }
  ]
}

function calculateOptionChance(power: number, regionId: string, optionId: CommissionOption['optionId']): number {
  const delta = VISITOR_CONFIG.commissions[optionId].chanceDelta
  return roundTo(Math.max(0.05, Math.min(0.95, calculateCommissionChance(power, regionId) + delta)), 3)
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

function releaseVisitorSlot(save: SaveGame, visitorId: string, now: Date): void {
  const slot = save.visitRound.slots.find((entry) => entry.visitor?.id === visitorId)
  if (!slot) throw domainError('Visitor slot not found')
  delete slot.visitor
  slot.nextArrivalCheckAt = nextArrivalCheck(now).toISOString()
}

function archiveVisitor(save: SaveGame, visitor: Visitor): void {
  const slot = save.visitRound.slots.find((entry) => entry.visitor?.id === visitor.id)
  if (!slot) throw domainError('Visitor slot not found')
  save.visitHistory.unshift({
    id: `${save.visitRound.id}:${visitor.id}`,
    number: save.visitRound.number,
    slots: save.visitRound.slots.map((entry) => entry.id === slot.id
      ? { id: entry.id, visitor: structuredClone(visitor) }
      : { id: entry.id }),
    createdAt: visitor.departedAt ?? save.updatedAt
  })
  save.visitHistory = save.visitHistory.slice(0, VISIT_HISTORY_LIMIT)
}

function requireTradeableVisitor(save: SaveGame, visitorId: string): Visitor {
  const visitor = findVisitor(save, visitorId)
  if (visitor.state !== 'open' && visitor.state !== 'traded') throw domainError('Visitor is no longer available for trade')
  return visitor
}

function findVisitor(save: SaveGame, visitorId: string): Visitor {
  const visitor = currentVisitors(save).find((entry) => entry.id === visitorId)
  if (!visitor) throw domainError('Visitor not found in current round')
  return visitor
}

function currentVisitors(save: Pick<SaveGame, 'visitRound'>): Visitor[] {
  return save.visitRound.slots.flatMap((slot) => slot.visitor ? [slot.visitor] : [])
}

function nextArrivalCheck(now: Date): Date {
  return new Date(now.getTime() + VISITOR_CONFIG.arrivalCheckIntervalMs)
}

function isValidDate(value?: string): boolean {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime())
}

function safeDate(...values: Array<string | undefined>): Date {
  for (const value of values) if (isValidDate(value)) return new Date(value!)
  return new Date()
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
  const base = itemBases[randomInt(0, itemBases.length - 1, random)] ?? itemBases[0]!
  const rarityRoll = clampRandom(random())
  const rarity = rarityRoll < 0.55 ? 'normal' : rarityRoll < 0.82 ? 'magic' : rarityRoll < 0.96 ? 'rare' : 'unique'
  if (rarity === 'unique') {
    const candidates = uniqueItems.filter((item) => item.type === base.type)
    const unique = candidates.length ? pick(candidates, random) : pick(uniqueItems, random)
    return { ...unique, id: randomId(random), identified: false, affixes: unique.affixes.map((affix) => ({ ...affix })) }
  }

  const affixCount = rarity === 'normal' ? 0 : rarity === 'magic' ? 1 : 3
  const affixes = [...(base.implicit ?? []).map((affix) => ({ ...affix }))]
  const available = [...affixPool]
  for (let index = 0; index < affixCount && available.length; index += 1) {
    const selectedIndex = randomInt(0, available.length - 1, random)
    const selected = available.splice(selectedIndex, 1)[0]!
    affixes.push({ ...selected })
  }
  const multiplier = rarity === 'magic' ? 1.8 : rarity === 'rare' ? 3.2 : 1
  return {
    id: randomId(random), baseName: base.baseName,
    displayName: rarity === 'normal' ? base.baseName : `${rarity[0]!.toUpperCase()}${rarity.slice(1)} ${base.baseName}`,
    type: base.type, rarity, identified: rarity === 'normal', width: base.width, height: base.height,
    requiredLevel: base.requiredLevel, affixes, value: Math.round(base.value * multiplier)
  }
}

function cloneItem(item: Item): Item {
  return { ...item, affixes: item.affixes.map((affix) => ({ ...affix })), position: item.position ? { ...item.position } : undefined }
}

function percentage(value: number, min: number, max: number, random: RandomSource): number {
  return Math.max(1, Math.round(value * (min + clampRandom(random()) * (max - min))))
}

function capQuoteForAcquisition(item: Item, quote: number): number {
  return item.acquisitionCost === undefined ? quote : Math.min(quote, item.acquisitionCost)
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
  return `rng-${Math.floor(clampRandom(random()) * Number.MAX_SAFE_INTEGER).toString(36).padStart(11, '0')}`
}

function touch(save: SaveGame, now: Date): SaveGame {
  save.updatedAt = now.toISOString()
  return save
}

function domainError(message: string): VisitorDomainError {
  return new VisitorDomainError(message)
}
