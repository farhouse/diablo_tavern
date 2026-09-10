import { describe, expect, it } from 'vitest'
import { createSaveGame, normalizeSaveGame, sellItem } from '../utils/game-logic'
import {
  assignVisitorCommission,
  buyFromVisitor,
  claimVisitorCommission,
  createVisitRound,
  dismissVisitor,
  hasCommercialAction,
  sellToVisitor
} from '../utils/visitor-logic'

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
    expect(save.visitRound.visitors).toHaveLength(2)
    expect(hasCommercialAction(save)).toBe(true)

    const snapshot = JSON.stringify(save.visitRound)
    const reloaded = normalizeSaveGame(JSON.parse(JSON.stringify(save)))
    expect(JSON.stringify(reloaded.visitRound)).toBe(snapshot)
  })

  it('persists prices in the required bands', () => {
    const save = createSaveGame('prices')
    save.visitRound = createVisitRound(save, 2, new Date('2026-01-01T00:00:00Z'), seeded(42))
    for (const visitor of save.visitRound.visitors) {
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

  it('buys once and rejects insufficient funds, full stash, and repeated trade', () => {
    const save = createSaveGame('buyer')
    const visitor = save.visitRound.visitors[0]!
    const offer = visitor.offers[0]!
    save.gold = offer.price - 1
    expect(() => buyFromVisitor(save, visitor.id, offer.id, 'poor')).toThrow('Not enough gold')
    save.gold = offer.price
    save.stashLimit = save.stash.length
    expect(() => buyFromVisitor(save, visitor.id, offer.id, 'full')).toThrow('Stash is full')
    save.stashLimit += 1
    buyFromVisitor(save, visitor.id, offer.id, 'buy-1')
    expect(save.gold).toBe(0)
    expect(() => buyFromVisitor(save, visitor.id, offer.id, 'buy-2')).toThrow('no longer available')
  })

  it('rejects incompatible sales and improves commission odds for useful gear', () => {
    const save = createSaveGame('seller')
    const item = save.stash[0]!
    const visitor = save.visitRound.visitors[0]!
    visitor.class = 'barbarian'
    visitor.level = 10
    visitor.acceptedItemTypes = [item.type]
    visitor.interestedItemTypes = [item.type]
    visitor.buyQuotes = { [item.id]: item.value }
    visitor.budget = item.value
    const before = visitor.commissionOptions[0]!.successChance
    sellToVisitor(save, visitor.id, item.id, 'sell-1')
    expect(visitor.power).toBeGreaterThan(0)
    expect(visitor.commissionOptions[0]!.successChance).toBeGreaterThan(before)

    const other = save.visitRound.visitors[1]!
    const remaining = save.stash[0]!
    other.acceptedItemTypes = other.acceptedItemTypes.filter((type) => type !== remaining.type)
    expect(() => sellToVisitor(save, other.id, remaining.id, 'bad-interest')).toThrow('not interested')
  })

  it('seals commission outcome, enforces readiness, and prevents duplicate claims', () => {
    const save = createSaveGame('commission')
    const visitor = save.visitRound.visitors[0]!
    const item = save.stash[0]!
    visitor.acceptedItemTypes = [item.type]
    visitor.interestedItemTypes = [item.type]
    visitor.buyQuotes = { [item.id]: item.value }
    visitor.budget = item.value
    sellToVisitor(save, visitor.id, item.id, 'trade')
    const start = new Date('2026-01-01T00:00:00Z')
    const region = visitor.commissionOptions[0]!.regionId
    assignVisitorCommission(save, visitor.id, region, () => 0.1, start)
    const sealedRoll = visitor.commission!.outcomeRoll
    const reloaded = normalizeSaveGame(JSON.parse(JSON.stringify(save)))
    expect(reloaded.visitRound.visitors[0]!.commission!.outcomeRoll).toBe(sealedRoll)
    expect(() => claimVisitorCommission(save, visitor.id, start)).toThrow('not ready')
    const finished = new Date(visitor.commission!.finishesAt)
    claimVisitorCommission(save, visitor.id, finished, seeded(5))
    expect(visitor.commission!.outcomeRoll).toBe(sealedRoll)
    expect(visitor.commission!.status).toBe('claimed')
    expect(() => claimVisitorCommission(save, visitor.id, finished)).toThrow('not ready')
  })

  it('enforces at most two unclaimed commissions', () => {
    const save = createSaveGame('commission-limit')
    const third = createVisitRound(save, 99, new Date(), seeded(88)).visitors[0]!
    third.id = 'third-visitor'
    save.visitRound.visitors.push(third)
    for (const visitor of save.visitRound.visitors) visitor.state = 'traded'
    for (const visitor of save.visitRound.visitors.slice(0, 2)) {
      assignVisitorCommission(save, visitor.id, visitor.commissionOptions[0]!.regionId, seeded(3))
    }
    expect(() => assignVisitorCommission(save, third.id, third.commissionOptions[0]!.regionId, seeded(4)))
      .toThrow('limit reached')
  })

  it('normalizes legacy saves without deleting historical heroes', () => {
    const legacy = createSaveGame('legacy') as unknown as Record<string, unknown>
    const historicalHeroes = [{ id: 'old-hero', status: 'dead' }]
    legacy.heroes = historicalHeroes
    delete legacy.visitRound
    delete legacy.visitHistory
    delete legacy.processedRequestIds
    delete legacy.processedRequests
    delete legacy.revision

    const migrated = normalizeSaveGame(legacy as unknown as ReturnType<typeof createSaveGame>)
    expect(migrated.heroes).toEqual(historicalHeroes)
    expect(migrated.visitRound.visitors).toHaveLength(2)
    expect(hasCommercialAction(migrated)).toBe(true)
  })

  it('replaces a round only after both visitors resolve', () => {
    const save = createSaveGame('rounds')
    const firstRoundId = save.visitRound.id
    dismissVisitor(save, save.visitRound.visitors[0]!.id, new Date(), seeded(2))
    expect(save.visitRound.id).toBe(firstRoundId)
    dismissVisitor(save, save.visitRound.visitors[1]!.id, new Date(), seeded(3))
    expect(save.visitRound.id).not.toBe(firstRoundId)
    expect(save.visitRound.number).toBe(2)
    expect(hasCommercialAction(save)).toBe(true)
  })

  it('salvages generic sales for 25% instead of full value', () => {
    const save = createSaveGame('salvage')
    const item = save.stash[0]!
    const initialGold = save.gold
    sellItem(save, item.id)
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
      const visitor = save.visitRound.visitors[0]!
      const sellable = save.stash.find((item) => visitor.buyQuotes[item.id] !== undefined)
      if (sellable) sellToVisitor(save, visitor.id, sellable.id, `sell-${round}`)
      else {
        const offer = visitor.offers.filter((entry) => entry.price <= save.gold).sort((a, b) => a.price - b.price)[0]
        if (offer) buyFromVisitor(save, visitor.id, offer.id, `buy-${round}`)
      }
      for (const current of [...save.visitRound.visitors]) {
        if (current.state !== 'departed') dismissVisitor(save, current.id, new Date(round + 1), random)
      }
      netGold += save.gold - before
    }

    expect(softLocks).toBe(0)
    expect(netGold / 1000).toBeLessThan(5)
    expect(save.gold).toBeLessThan(startingGold * 10)
  })
})
