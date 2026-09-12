import { describe, expect, it } from 'vitest'
import type { SaveGame, VisitRound } from '../types/game'
import { createSaveGame, normalizeSaveGame } from '../utils/game-logic'
import { itemBases, quests } from '../utils/game-data'
import {
  assignVisitorCommission,
  buyFromVisitor,
  claimVisitorCommission,
  createVisitRound,
  dismissVisitor,
  hasCommercialAction,
  hasPurchaseAction,
  hasSaleAction,
  refreshVisitRound,
  salvageItem,
  sellToVisitor
} from '../utils/visitor-logic'

const roundVisitors = (round: VisitRound) => round.slots.flatMap((slot) => slot.visitor ? [slot.visitor] : [])
const visitors = (save: Pick<SaveGame, 'visitRound'>) => roundVisitors(save.visitRound)

function seeded(seed = 1): () => number {
  return () => {
    seed |= 0
    seed = seed + 0x6D2B79F5 | 0
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed)
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
}

describe('visitor trade and commission loop', () => {
  it('creates the new-game contract with persisted viable visitors and starter items', () => {
    const save = createSaveGame('new-user')
    expect(save.gold).toBe(450)
    expect(save.stash).toHaveLength(2)
    expect(save.stash.every((item) => item.rarity === 'normal' && item.identified)).toBe(true)
    expect(save.visitRound.slots).toHaveLength(2)
    expect(visitors(save)).toHaveLength(2)
    expect(hasCommercialAction(save)).toBe(true)
    expect(hasPurchaseAction(save)).toBe(true)
    expect(hasSaleAction(save)).toBe(true)
    for (const visitor of visitors(save)) {
      expect(visitor.origin).toBeTruthy()
      expect(visitor.equipmentSummary).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: expect.any(String), type: expect.any(String), powerBonus: expect.any(Number) })
      ]))
    }

    const snapshot = JSON.stringify(save.visitRound)
    const reloaded = normalizeSaveGame(JSON.parse(JSON.stringify(save)))
    expect(JSON.stringify(reloaded.visitRound)).toBe(snapshot)
  })

  it('turns a guaranteed sale into a real purchase opportunity from a full, cashless stash', () => {
    const save = createSaveGame('commercial-sequence')
    save.gold = 0
    save.stashLimit = save.stash.length
    save.visitRound = createVisitRound(save, 2, new Date('2026-01-01T00:00:00Z'), seeded(19))
    const visitor = visitors(save)[0]!
    const sellable = save.stash.find((item) => visitor.buyQuotes[item.id] !== undefined)!

    expect(hasSaleAction(save)).toBe(true)
    expect(hasPurchaseAction(save)).toBe(false)
    sellToVisitor(save, visitor.id, sellable.id, 'unlock-purchase')
    expect(hasPurchaseAction(save)).toBe(true)
    const offer = visitor.offers.find((entry) => !entry.purchasedAt && entry.price <= save.gold)!
    buyFromVisitor(save, visitor.id, offer.id, 'purchase-after-sale')
    expect(visitor.trades.map((trade) => trade.kind)).toEqual(['player_sold', 'player_bought'])
  })

  it('recovers a full, cashless stash of unidentified items without exceeding its capacity', () => {
    const save = createSaveGame('unidentified-commercial-recovery')
    save.gold = 0
    save.stashLimit = save.stash.length
    for (const item of save.stash) item.identified = false
    const originalItemIds = save.stash.map((item) => item.id)

    save.visitRound = createVisitRound(save, 2, new Date('2026-01-01T00:00:00Z'), seeded(23))
    const visitor = visitors(save)[0]!
    const sellable = save.stash.find((item) => item.identified && visitor.buyQuotes[item.id] !== undefined)

    expect(save.stash).toHaveLength(save.stashLimit)
    expect(save.stash.map((item) => item.id)).toEqual(originalItemIds)
    expect(sellable).toBeTruthy()
    expect(hasSaleAction(save)).toBe(true)
    expect(hasPurchaseAction(save)).toBe(false)

    sellToVisitor(save, visitor.id, sellable!.id, 'recovery-sale')
    expect(hasPurchaseAction(save)).toBe(true)
    const offer = visitor.offers.find((entry) => !entry.purchasedAt && entry.price <= save.gold)
    expect(offer).toBeTruthy()
    buyFromVisitor(save, visitor.id, offer!.id, 'recovery-purchase')
    expect(save.stash).toHaveLength(save.stashLimit)
  })

  it('guarantees the post-recovery purchase for the cheapest item at the minimum quote roll', () => {
    const save = createSaveGame('minimum-unidentified-commercial-recovery')
    const cheapestBase = itemBases.reduce((cheapest, base) => base.value < cheapest.value ? base : cheapest)
    save.gold = 0
    save.stash = [{
      ...save.stash[0]!,
      ...cheapestBase,
      displayName: cheapestBase.baseName,
      affixes: cheapestBase.implicit ?? [],
      identified: false
    }]
    save.stashLimit = 1

    save.visitRound = createVisitRound(save, 2, new Date('2026-01-01T00:00:00Z'), () => 0)
    const visitor = visitors(save)[0]!
    const sellable = save.stash[0]!

    expect(sellable.identified).toBe(true)
    expect(visitor.buyQuotes[sellable.id]).toBeGreaterThanOrEqual(Math.round(cheapestBase.value * 0.90))
    expect(save.stash).toHaveLength(save.stashLimit)

    sellToVisitor(save, visitor.id, sellable.id, 'minimum-recovery-sale')
    expect(hasPurchaseAction(save)).toBe(true)
    const offer = visitor.offers.find((entry) => !entry.purchasedAt && entry.price <= save.gold)
    expect(offer).toBeTruthy()
    buyFromVisitor(save, visitor.id, offer!.id, 'minimum-recovery-purchase')
    expect(save.stashLimit).toBe(1)
    expect(save.stash).toHaveLength(1)
    expect(visitor.trades.map((trade) => trade.kind)).toEqual(['player_sold', 'player_bought'])
  })

  it('persists prices in the required bands', () => {
    const save = createSaveGame('prices')
    save.visitRound = createVisitRound(save, 2, new Date('2026-01-01T00:00:00Z'), seeded(42))
    for (const visitor of visitors(save)) {
      for (const offer of visitor.offers) {
        expect(offer.price).toBeGreaterThanOrEqual(Math.round(offer.item.value * 0.90))
        expect(offer.price).toBeLessThanOrEqual(Math.round(offer.item.value * 1.25))
      }
      for (const item of save.stash) {
        const quote = visitor.buyQuotes[item.id]
        if (quote === undefined) continue
        const desired = visitor.interestedItemTypes.includes(item.type)
        expect(quote).toBeGreaterThanOrEqual(Math.round(item.value * (desired ? 0.80 : 0.40)))
        expect(quote).toBeLessThanOrEqual(Math.round(item.value * (desired ? 1.10 : 0.60)))
      }
    }
  })

  it('allows one purchase and one sale with the same visitor, but not duplicate trade kinds', () => {
    const save = createSaveGame('buyer')
    const visitor = visitors(save)[0]!
    const offer = visitor.offers[0]!
    save.gold = offer.price - 1
    expect(() => buyFromVisitor(save, visitor.id, offer.id, 'poor')).toThrow('Not enough gold')
    save.gold = offer.price
    save.stashLimit = save.stash.length
    expect(() => buyFromVisitor(save, visitor.id, offer.id, 'full')).toThrow('Stash is full')
    save.stashLimit += 1
    buyFromVisitor(save, visitor.id, offer.id, 'buy-1')
    expect(save.gold).toBe(0)
    expect(() => buyFromVisitor(save, visitor.id, offer.id, 'buy-2')).toThrow('already completed a sale')
    const sellable = save.stash.find((item) => visitor.buyQuotes[item.id] !== undefined)
    expect(sellable).toBeTruthy()
    visitor.budget = Math.max(visitor.budget, visitor.buyQuotes[sellable!.id]!)
    sellToVisitor(save, visitor.id, sellable!.id, 'sell-after-buy')
    expect(visitor.trades.map((trade) => trade.kind)).toEqual(['player_bought', 'player_sold'])
  })

  it('rejects incompatible sales and improves commission odds for useful gear', () => {
    const save = createSaveGame('seller')
    const item = save.stash[0]!
    const visitor = visitors(save)[0]!
    visitor.class = 'barbarian'
    visitor.level = 10
    visitor.acceptedItemTypes = [item.type]
    visitor.interestedItemTypes = [item.type]
    visitor.buyQuotes = { [item.id]: item.value }
    visitor.budget = item.value
    const powerBefore = visitor.power
    const before = visitor.commissionOptions[0]!.successChance
    sellToVisitor(save, visitor.id, item.id, 'sell-1')
    expect(visitor.power).toBeGreaterThan(0)
    expect(visitor.commissionOptions[0]!.successChance).toBeGreaterThan(before)
    expect(visitor.equipmentSummary).toContainEqual({
      itemId: item.id,
      name: item.displayName,
      type: item.type,
      powerBonus: visitor.power - powerBefore
    })

    const reloaded = normalizeSaveGame(JSON.parse(JSON.stringify(save)))
    expect(visitors(reloaded)[0]!.equipmentSummary).toEqual(visitor.equipmentSummary)
    expect(visitors(reloaded)[0]!.power).toBe(visitor.power)

    const other = visitors(save)[1]!
    const remaining = save.stash[0]!
    other.acceptedItemTypes = other.acceptedItemTypes.filter((type) => type !== remaining.type)
    expect(() => sellToVisitor(save, other.id, remaining.id, 'bad-interest')).toThrow('not interested')
  })

  it('never quotes or buys unidentified stash items', () => {
    const save = createSaveGame('unidentified-sale')
    const item = save.stash[0]!
    item.identified = false
    const round = createVisitRound(save, 2, new Date('2026-01-01T00:00:00Z'), seeded(12))
    expect(roundVisitors(round).every((entry) => entry.buyQuotes[item.id] === undefined)).toBe(true)

    const visitor = visitors(save)[0]!
    visitor.acceptedItemTypes = [item.type]
    visitor.buyQuotes[item.id] = item.value
    visitor.budget = item.value
    expect(() => sellToVisitor(save, visitor.id, item.id, 'hidden-sale')).toThrow('must be identified')
  })

  it('seals commission outcome, enforces readiness, and prevents duplicate claims', () => {
    const save = createSaveGame('commission')
    const visitor = visitors(save)[0]!
    const item = save.stash[0]!
    visitor.acceptedItemTypes = [item.type]
    visitor.interestedItemTypes = [item.type]
    visitor.buyQuotes = { [item.id]: item.value }
    visitor.budget = item.value
    sellToVisitor(save, visitor.id, item.id, 'trade')
    const start = new Date('2026-01-01T00:00:00Z')
    const optionId = visitor.commissionOptions[0]!.optionId
    assignVisitorCommission(save, visitor.id, optionId, () => 0.1, start)
    const sealedRoll = visitor.commission!.outcomeRoll
    const reloaded = normalizeSaveGame(JSON.parse(JSON.stringify(save)))
    expect(visitors(reloaded)[0]!.commission!.outcomeRoll).toBe(sealedRoll)
    expect(() => claimVisitorCommission(save, visitor.id, start)).toThrow('not ready')
    const finished = new Date(visitor.commission!.finishesAt)
    claimVisitorCommission(save, visitor.id, finished, seeded(5))
    expect(visitor.commission!.outcomeRoll).toBe(sealedRoll)
    expect(visitor.commission!.status).toBe('claimed')
    expect(save.visitHistory[0]!.slots.flatMap((slot) => slot.visitor ? [slot.visitor.id] : [])).toContain(visitor.id)
    expect(() => claimVisitorCommission(save, visitor.id, finished)).toThrow('not found')
  })

  it('enforces at most two unclaimed commissions', () => {
    const save = createSaveGame('commission-limit')
    const third = roundVisitors(createVisitRound(save, 99, new Date(), seeded(88)))[0]!
    third.id = 'third-visitor'
    save.visitRound.slots.push({ id: 'visitor-slot-3', visitor: third })
    for (const visitor of visitors(save)) visitor.state = 'traded'
    for (const visitor of visitors(save).slice(0, 2)) {
      assignVisitorCommission(save, visitor.id, visitor.commissionOptions[0]!.optionId, seeded(3))
    }
    expect(() => assignVisitorCommission(save, third.id, third.commissionOptions[0]!.optionId, seeded(4)))
      .toThrow('limit reached')
  })

  it('repairs missing current visitor details without losing an existing power increase', () => {
    const save = createSaveGame('legacy-visitor-details')
    const visitor = visitors(save)[0]!
    visitor.power += 17
    delete (visitor as Partial<typeof visitor>).origin
    delete (visitor as Partial<typeof visitor>).equipmentSummary

    const migrated = normalizeSaveGame(JSON.parse(JSON.stringify(save)))
    const migratedVisitor = visitors(migrated)[0]!

    expect(migratedVisitor.origin).toBeTruthy()
    expect(migratedVisitor.equipmentSummary).toContainEqual(expect.objectContaining({
      name: 'Equipment acquired at the tavern',
      powerBonus: 17
    }))
    expect(migratedVisitor.power).toBe(visitor.power)
  })

  it('repairs malformed and partial equipment summaries without losing power', () => {
    const save = createSaveGame('partial-visitor-equipment')
    const visitor = visitors(save)[0]!
    visitor.power += 13
    visitor.equipmentSummary = [
      visitor.equipmentSummary[0]!,
      { name: '', type: 'weapon', powerBonus: Number.NaN }
    ]

    const migrated = normalizeSaveGame(JSON.parse(JSON.stringify(save)))
    const summary = visitors(migrated)[0]!.equipmentSummary

    expect(summary.every((item) => item.name && item.type && Number.isFinite(item.powerBonus))).toBe(true)
    expect(summary.reduce((sum, item) => sum + item.powerBonus, 0)).toBe(13)
  })

  it('repairs incomplete current options using the hardest unlocked region', () => {
    const save = createSaveGame('legacy-options')
    const visitor = visitors(save)[0]!
    const originalOption = visitor.commissionOptions[0]!
    visitor.state = 'commissioned'
    visitor.commission = {
      ...originalOption,
      id: 'legacy-active',
      status: 'active',
      startedAt: '2030-01-01T00:00:00.000Z',
      finishesAt: '2030-01-01T00:02:00.000Z',
      outcomeRoll: 0.42
    }
    const legacyCommission = visitor.commission as Partial<typeof visitor.commission> & Record<string, unknown>
    delete legacyCommission.optionId
    delete legacyCommission.title
    delete legacyCommission.riskLevel
    delete legacyCommission.failureConsequence
    visitor.commissionOptions = visitor.commissionOptions.map(({ optionId: _optionId, ...option }) => option) as typeof visitor.commissionOptions
    save.unlockedRegionIds = quests.map((quest) => quest.id)

    const migrated = normalizeSaveGame(JSON.parse(JSON.stringify(save)))
    const hardest = [...quests].sort((a, b) => b.difficulty - a.difficulty)[0]!
    const migratedVisitor = visitors(migrated)[0]!

    expect(migratedVisitor.commissionOptions).toHaveLength(2)
    expect(migratedVisitor.commissionOptions.every((option) => option.regionId === hardest.id)).toBe(true)
    expect(migratedVisitor.commission).toMatchObject({
      id: 'legacy-active',
      durationMs: originalOption.durationMs,
      successChance: originalOption.successChance,
      fullRewardGold: originalOption.fullRewardGold,
      partialRewardGold: originalOption.partialRewardGold,
      startedAt: '2030-01-01T00:00:00.000Z',
      finishesAt: '2030-01-01T00:02:00.000Z',
      outcomeRoll: 0.42
    })
  })

  it('frees a dismissed slot and persists probabilistic arrival checks while commissions keep theirs occupied', () => {
    const save = createSaveGame('slots')
    const [dismissed, commissioned] = visitors(save)
    dismissed!.state = 'traded'
    commissioned!.state = 'traded'
    const start = new Date('2026-01-01T00:00:00.000Z')
    assignVisitorCommission(save, commissioned!.id, commissioned!.commissionOptions[0]!.optionId, seeded(8), start)
    dismissVisitor(save, dismissed!.id, start)

    const emptySlot = save.visitRound.slots.find((slot) => !slot.visitor)!
    expect(emptySlot.nextArrivalCheckAt).toBe('2026-01-01T00:00:30.000Z')
    expect(save.visitHistory[0]!.slots.some((slot) => slot.visitor?.id === dismissed!.id)).toBe(true)
    expect(save.visitRound.slots.some((slot) => slot.visitor?.id === commissioned!.id)).toBe(true)

    refreshVisitRound(save, new Date(emptySlot.nextArrivalCheckAt!), () => 0.9)
    expect(emptySlot.visitor).toBeUndefined()
    expect(emptySlot.nextArrivalCheckAt).toBe('2026-01-01T00:01:00.000Z')

    refreshVisitRound(save, new Date(emptySlot.nextArrivalCheckAt!), () => 0)
    expect(emptySlot.visitor).toBeDefined()
    expect(emptySlot.nextArrivalCheckAt).toBeUndefined()
    expect(hasPurchaseAction(save)).toBe(true)
    expect(hasSaleAction(save)).toBe(true)
  })

  it('offers exactly two commissions with distinct probability, duration, reward, and risk', () => {
    const save = createSaveGame('commission-options')
    const options = visitors(save)[0]!.commissionOptions
    expect(options.map((option) => option.optionId)).toEqual(['safe', 'risky'])
    expect(options).toHaveLength(2)
    expect(options[0]!.successChance).toBeGreaterThan(options[1]!.successChance)
    expect(options[0]!.durationMs).toBeLessThan(options[1]!.durationMs)
    expect(options[0]!.fullRewardGold).toBeLessThan(options[1]!.fullRewardGold)
    expect(options[0]!.riskLevel).not.toBe(options[1]!.riskLevel)

    const visitor = visitors(save)[0]!
    visitor.state = 'traded'
    assignVisitorCommission(save, visitor.id, options[0]!.optionId, seeded(4))
    expect(visitor.commission!.optionId).toBe('safe')
  })

  it('salvages generic sales for 25% instead of full value', () => {
    const save = createSaveGame('salvage')
    const item = save.stash[0]!
    const initialGold = save.gold
    salvageItem(save, item.id)
    expect(save.gold - initialGold).toBe(Math.floor(item.value * 0.25))
  })

  it('simulates 1,000 deterministic rounds without soft-lock or explosive gold growth', () => {
    const random = seeded(20260910)
    const save = createSaveGame('simulation')
    save.visitRound = createVisitRound(save, 1, new Date(0), random)
    const startingGold = save.gold
    let softLocks = 0
    let netGold = 0

    for (let round = 0; round < 1000; round += 1) {
      if (!hasCommercialAction(save)) softLocks += 1
      const before = save.gold
      const visitor = visitors(save)[0]!
      const sellable = save.stash.find((item) => visitor.buyQuotes[item.id] !== undefined)
      if (sellable) sellToVisitor(save, visitor.id, sellable.id, `sell-${round}`)
      const offer = visitor.offers.filter((entry) => !entry.purchasedAt && entry.price <= save.gold).sort((a, b) => a.price - b.price)[0]
      if (offer && save.stash.length < save.stashLimit) buyFromVisitor(save, visitor.id, offer.id, `buy-${round}`)
      if (visitor.state !== 'departed') dismissVisitor(save, visitor.id, new Date(round * 60_000), random)
      refreshVisitRound(save, new Date(round * 60_000 + 30_000), () => 0)
      netGold += save.gold - before
    }

    expect(softLocks).toBe(0)
    expect(netGold).toBe(-450)
    expect(save.gold).toBe(0)
    expect(netGold / 1000).toBeLessThan(5)
    expect(save.gold).toBeLessThan(startingGold * 10)
  })
})
