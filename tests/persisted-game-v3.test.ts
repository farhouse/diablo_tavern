import { describe, expect, it } from 'vitest'
import { createSaveGame } from '../utils/game-logic'
import { buildPersistedFromPublic, isPersistedCanonical } from '../server/utils/savegame'
import { mapPersistedGameToGameView } from '../server/domain/game-view'
import { applyItemTransition, effectiveCapacityUsed } from '../server/domain/item-transitions'

describe('PersistedGameV3 invariants', () => {
  it('stores each actionable item once and only references it from containers', () => {
    const persisted = buildPersistedFromPublic(createSaveGame('canonical-user'))
    expect(isPersistedCanonical(persisted)).toBe(true)
    expect(new Set(Object.keys(persisted.itemsById)).size).toBe(Object.keys(persisted.itemsById).length)
    expect(Object.keys(persisted.itemPlacements).sort()).toEqual(Object.keys(persisted.itemsById).sort())
    for (const round of [persisted.visitRound, ...persisted.visitHistory]) {
      for (const visitor of round.slots.flatMap((slot) => slot.visitor ? [slot.visitor] : [])) {
        expect(visitor.offers.every((offer) => !Object.hasOwn(offer, 'item') && Boolean(offer.itemId))).toBe(true)
        if (visitor.commission) expect(visitor.commission).not.toHaveProperty('rewardItem')
      }
    }
  })

  it('never exposes persistence bookkeeping through the contractual GameView', () => {
    const persisted = buildPersistedFromPublic(createSaveGame('projection-user'))
    const view = mapPersistedGameToGameView(persisted, new Date('2026-09-13T12:00:00.000Z'))
    expect(view.contractVersion).toBe('v2-etapa0-3')
    expect(view.capacity.used).toBe(effectiveCapacityUsed(persisted))
    expect(view.visitors).toHaveLength(2)
    expect(view.items).toContainEqual(expect.objectContaining({
      owner: expect.objectContaining({ kind: 'visitor' }),
      custody: expect.objectContaining({ kind: 'visitor' })
    }))
    for (const key of ['userId', 'itemsById', 'itemPlacements', 'requestRecords', 'businessKeys', 'ledger', 'serviceJobsById']) {
      expect(view).not.toHaveProperty(key)
    }
  })

  it('rejects capacity overflow, dangling custody and visitor-reference disagreement', () => {
    const capacity = buildPersistedFromPublic(createSaveGame('invalid-capacity'))
    capacity.stashLimit = 1
    expect(isPersistedCanonical(capacity)).toBe(false)

    const dangling = buildPersistedFromPublic(createSaveGame('invalid-custody'))
    const itemId = dangling.stash[0]!
    dangling.stash = dangling.stash.filter((id) => id !== itemId)
    dangling.itemPlacements[itemId] = { ownerKind: 'caravan', custodyKind: 'service', custodyId: 'missing-job' }
    expect(isPersistedCanonical(dangling)).toBe(false)

    const visitorMismatch = buildPersistedFromPublic(createSaveGame('invalid-visitor'))
    const offer = visitorMismatch.visitRound.slots[0]!.visitor!.offers[0]!
    visitorMismatch.itemPlacements[offer.itemId] = { ownerKind: 'visitor', ownerId: 'foreign', custodyKind: 'visitor', custodyId: 'foreign' }
    expect(isPersistedCanonical(visitorMismatch)).toBe(false)
  })

  it('uses injected clock, RNG and UUID sources deterministically', () => {
    let seed = 7
    const dependencies = {
      now: () => new Date('2030-01-02T03:04:05.000Z'),
      random: () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32),
      uuid: () => 'fixed-uuid'
    }
    const save = createSaveGame('injected-user', dependencies.now(), dependencies.random)
    save.stash[0]!.id = ''
    const persisted = buildPersistedFromPublic(save, undefined, dependencies)
    expect(persisted.createdAt).toBe('2030-01-02T03:04:05.000Z')
    expect(persisted.itemsById['item-fixed-uuid']).toBeDefined()
  })

  it('preserves identity, ownership and resource deltas over deterministic generated sequences', () => {
    let seed = 0x43a33
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
    const operations = ['loan', 'service', 'recover', 'return', 'sell', 'dismantle'] as const

    for (let run = 0; run < 200; run += 1) {
      let state = buildPersistedFromPublic(createSaveGame(`property-${run}`))
      const originalIds = Object.keys(state.itemsById).sort()
      for (let step = 0; step < 20; step += 1) {
        const itemId = originalIds[Math.floor(random() * originalIds.length)]!
        const operation = operations[Math.floor(random() * operations.length)]!
        const beforeGold = state.gold
        const beforeMaterials = state.materials.scrap ?? 0
        try {
          const result = applyItemTransition(state, { operation, itemId, targetId: `target-${step}` })
          state = result.game
          expect(state.gold - beforeGold).toBe(result.effect.goldDelta)
          expect((state.materials.scrap ?? 0) - beforeMaterials).toBe(result.effect.materialDeltas.scrap ?? 0)
        } catch (error) {
          expect((error as Error).name).toBe('ItemTransitionError')
        }
        expect(Object.keys(state.itemsById).sort()).toEqual(originalIds)
        expect(isPersistedCanonical(state)).toBe(true)
        expect(effectiveCapacityUsed(state)).toBeLessThanOrEqual(state.stashLimit)
      }
    }
  })

  it.each([
    ['sell', 'loan'],
    ['sell', 'dismantle'],
    ['service', 'loan']
  ] as const)('allows exactly one winner for %s versus %s on the same snapshot', (first, second) => {
    const initial = buildPersistedFromPublic(createSaveGame(`race-${first}-${second}`))
    const itemId = initial.stash[0]!
    const visitorId = initial.visitRound.slots.find((slot) => slot.visitor)?.visitor?.id ?? 'missing'
    const target = (operation: typeof first | typeof second, fallback: string) => operation === 'sell' ? visitorId : fallback
    const winner = applyItemTransition(initial, { operation: first, itemId, targetId: target(first, 'winner') }).game
    expect(() => applyItemTransition(winner, { operation: second, itemId, targetId: target(second, 'loser') }))
      .toThrow(expect.objectContaining({ name: 'ItemTransitionError' }))
  })
})
