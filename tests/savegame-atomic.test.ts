import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SaveGame } from '../types/game'
import { createSaveGame } from '../utils/game-logic'
import type { PersistedGameV3 } from '../server/utils/savegame'
import { generateLootForZone, LOOT_CONFIG_VERSION } from '../server/domain/loot-v2'

let document: PersistedGameV3 | Record<string, unknown> | undefined
let uncertainCommit = false
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET
const ORIGINAL_NUXT_JWT_SECRET = process.env.NUXT_JWT_SECRET

const collection = {
  findOne: vi.fn(async () => document ? structuredClone(document) : null),
  updateOne: vi.fn(async (_filter: unknown, update: { $setOnInsert: PersistedGameV3 }) => {
    if (document) return { upsertedCount: 0, modifiedCount: 0 }
    document = structuredClone(update.$setOnInsert)
    return { upsertedCount: 1, modifiedCount: 0 }
  }),
  replaceOne: vi.fn(async (rawFilter: unknown, replacement: PersistedGameV3) => {
    const filter = rawFilter as { revision?: number; $or?: Array<{ revision: number | { $exists: boolean } }> }
    if (!document) return { modifiedCount: 0 }
    const revision = typeof document.revision === 'number' ? document.revision : undefined
    const matches = typeof filter.revision === 'number'
      ? revision === filter.revision
      : !filter.$or || filter.$or.some((entry) => typeof entry.revision === 'number'
        ? revision === entry.revision
        : entry.revision.$exists === (revision !== undefined))
    if (!matches) return { modifiedCount: 0 }
    document = structuredClone(replacement)
    if (uncertainCommit) {
      uncertainCommit = false
      return { modifiedCount: 0 }
    }
    return { modifiedCount: 1 }
  })
}

vi.mock('../server/utils/db', () => ({ saveGamesCollection: async () => collection }))

describe('atomic persisted-game mutation', () => {
  beforeEach(async () => {
    vi.doUnmock('../server/domain/game-view')
    vi.doUnmock('../server/utils/auth')
    vi.doUnmock('../server/utils/savegame')
    const { buildPersistedFromPublic } = await import('../server/utils/savegame')
    process.env.JWT_SECRET = 'test-secret-for-equipment-v2'
    delete process.env.NUXT_JWT_SECRET
    document = buildPersistedFromPublic(createSaveGame('atomic-user'))
    uncertainCommit = false
    vi.clearAllMocks()
  })

  afterEach(() => {
    if (ORIGINAL_JWT_SECRET === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET
    if (ORIGINAL_NUXT_JWT_SECRET === undefined) delete process.env.NUXT_JWT_SECRET
    else process.env.NUXT_JWT_SECRET = ORIGINAL_NUXT_JWT_SECRET
    vi.doUnmock('../server/domain/game-view')
    vi.doUnmock('../server/utils/auth')
    vi.doUnmock('../server/utils/savegame')
  })

  it('persists and replays the exact command once without public bookkeeping', async () => {
    const { mutateSaveGameAtomic } = await import('../server/utils/savegame')
    const mutate = vi.fn((save: SaveGame) => { save.gold += 100 })
    const command = { requestId: 'request-1', expectedRevision: 0, amount: 100 }
    const first = await mutateSaveGameAtomic('atomic-user', 'request-1', 'credit:one', 0, command, mutate)
    const replay = await mutateSaveGameAtomic('atomic-user', 'request-1', 'credit:one', 999, { ...command, expectedRevision: 999 }, mutate)
    expect(first.gold).toBe(550)
    expect(replay).toEqual(first)
    expect(mutate).toHaveBeenCalledOnce()
    expect(first).not.toHaveProperty('userId')
    expect(first).not.toHaveProperty('processedRequests')
    expect((document as PersistedGameV3).ledger).toMatchObject([{ businessKey: 'credit:one', goldDelta: 100 }])
  })

  it('rejects requestId reuse with another command hash', async () => {
    const { IdempotencyConflictError, mutateSaveGameAtomic } = await import('../server/utils/savegame')
    await mutateSaveGameAtomic('atomic-user', 'reused', 'credit:one', 0, { amount: 1 }, (save) => { save.gold += 1 })
    await expect(mutateSaveGameAtomic('atomic-user', 'reused', 'credit:one', 0, { amount: 2 }, () => {}))
      .rejects.toBeInstanceOf(IdempotencyConflictError)
  })

  it('includes the operation in the hash even when payloads match', async () => {
    const { IdempotencyConflictError, mutateSaveGameAtomic } = await import('../server/utils/savegame')
    await mutateSaveGameAtomic('atomic-user', 'cross-operation', 'credit:one', 0, { amount: 1 }, () => {})
    await expect(mutateSaveGameAtomic('atomic-user', 'cross-operation', 'debit:one', 1, { amount: 1 }, () => {}))
      .rejects.toBeInstanceOf(IdempotencyConflictError)
  })

  it('rejects stale revisions before running or recording effects', async () => {
    const { mutateSaveGameAtomic, RevisionConflictError } = await import('../server/utils/savegame')
    const mutate = vi.fn()
    await expect(mutateSaveGameAtomic('atomic-user', 'stale', 'stale:key', 4, {}, mutate))
      .rejects.toBeInstanceOf(RevisionConflictError)
    expect(mutate).not.toHaveBeenCalled()
    expect((document as PersistedGameV3).requestRecords).toEqual([])
  })

  it('allows one winner for two requests against the same revision', async () => {
    const { mutateSaveGameAtomic, RevisionConflictError } = await import('../server/utils/savegame')
    const results = await Promise.allSettled([
      mutateSaveGameAtomic('atomic-user', 'race-a', 'race:a', 0, { amount: 20 }, (save) => { save.gold -= 20 }),
      mutateSaveGameAtomic('atomic-user', 'race-b', 'race:b', 0, { amount: 30 }, (save) => { save.gold -= 30 })
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)
      .toBeInstanceOf(RevisionConflictError)
    expect((document as PersistedGameV3).ledger).toHaveLength(1)
  })

  it('coalesces concurrent retries and recovers an uncertain response', async () => {
    const { mutateSaveGameAtomic } = await import('../server/utils/savegame')
    uncertainCommit = true
    const mutate = vi.fn((save: SaveGame) => { save.gold += 9 })
    const result = await mutateSaveGameAtomic('atomic-user', 'uncertain', 'credit:uncertain', 0, { amount: 9 }, mutate)
    expect(result.gold).toBe(459)
    expect(mutate).toHaveBeenCalledOnce()
    expect(collection.replaceOne).toHaveBeenCalledOnce()
  })

  it('keeps business keys permanent across request IDs', async () => {
    const { BusinessKeyConflictError, mutateSaveGameAtomic } = await import('../server/utils/savegame')
    await mutateSaveGameAtomic('atomic-user', 'business-a', 'transfer:item-1', 0, {}, () => {})
    await expect(mutateSaveGameAtomic('atomic-user', 'business-b', 'transfer:item-1', 1, {}, () => {}))
      .rejects.toBeInstanceOf(BusinessKeyConflictError)
  })

  it('rejects reuse of an expired requestId before executing another mutation', async () => {
    const { IdempotencyConflictError, mutateSaveGameAtomic, transitionItemAtomic } = await import('../server/utils/savegame')
    const persisted = document as PersistedGameV3
    persisted.revision = 1
    persisted.businessKeys['historic:key'] = 'historic-request'
    persisted.ledger.push({
      at: persisted.updatedAt, requestId: 'historic-request', operationKey: 'historic-operation',
      commandHash: 'a'.repeat(64), businessKey: 'historic:key', revision: 1,
      goldDelta: 0, materialDeltas: {}, itemChanges: []
    })
    const mutate = vi.fn((save: SaveGame) => { save.gold += 1 })

    await expect(mutateSaveGameAtomic('atomic-user', 'historic-request', 'new:key', 1, {}, mutate))
      .rejects.toBeInstanceOf(IdempotencyConflictError)
    expect(mutate).not.toHaveBeenCalled()

    const itemId = persisted.stash[0]!
    const visitorId = persisted.visitRound.slots.find((slot) => slot.visitor)?.visitor?.id!
    await expect(transitionItemAtomic('atomic-user', 'historic-request', 1, { operation: 'sell', itemId, targetId: visitorId }))
      .rejects.toBeInstanceOf(IdempotencyConflictError)
    expect(document).toEqual(persisted)
  })

  it('records material deltas and permits a later transition instance for the same item', async () => {
    const { getPersistedGameV3, transitionItemAtomic } = await import('../server/utils/savegame')
    const initial = await getPersistedGameV3('atomic-user')
    const itemId = initial.stash[0]!
    const [visitor, secondVisitor] = initial.visitRound.slots.flatMap((slot) => slot.visitor ? [slot.visitor] : [])
    if (!visitor || !secondVisitor) throw new Error('Expected two visitors')
    const visitorId = visitor.id
    visitor.commission = {
      ...visitor.commissionOptions[0]!, id: 'contract-a', status: 'active',
      startedAt: initial.updatedAt, finishesAt: initial.updatedAt, outcomeRoll: 0.5
    }
    visitor.state = 'commissioned'
    secondVisitor.commission = {
      ...secondVisitor.commissionOptions[0]!, id: 'contract-b', status: 'active',
      startedAt: initial.updatedAt, finishesAt: initial.updatedAt, outcomeRoll: 0.5
    }
    secondVisitor.state = 'commissioned'
    initial.expeditionsById['expedition-a'] = { id: 'expedition-a', itemIds: [], projection: { kind: 'expedition', visitorId, contractId: visitor.commission.id, startsAt: initial.updatedAt } }
    initial.expeditionsById['expedition-b'] = { id: 'expedition-b', itemIds: [], projection: { kind: 'expedition', visitorId: secondVisitor.id, contractId: secondVisitor.commission.id, startsAt: initial.updatedAt } }
    document = initial

    await transitionItemAtomic('atomic-user', 'loan-a', 0, { operation: 'loan', itemId, targetId: 'expedition-a' })
    await transitionItemAtomic('atomic-user', 'return-a', 1, { operation: 'return', itemId, targetId: 'expedition-a' })
    await transitionItemAtomic('atomic-user', 'loan-b', 2, { operation: 'loan', itemId, targetId: 'expedition-b' })
    const secondItem = (document as PersistedGameV3).stash.find((id) => id !== itemId)!
    await transitionItemAtomic('atomic-user', 'dismantle', 3, { operation: 'dismantle', itemId: secondItem, targetId: 'scrap' })

    expect((document as PersistedGameV3).ledger.at(-1)?.materialDeltas.scrap).toBeGreaterThan(0)
    expect((document as PersistedGameV3).ledger.map((entry) => entry.businessKey)).toContain(JSON.stringify(['item-transition', 'loan', itemId, 'expedition-b']))
  })

  it('rejects a return target that differs from current authoritative custody', async () => {
    const { getPersistedGameV3, transitionItemAtomic } = await import('../server/utils/savegame')
    const { ItemTransitionError } = await import('../server/domain/item-transitions')
    const initial = await getPersistedGameV3('atomic-user')
    const itemId = initial.stash[0]!
    const visitor = initial.visitRound.slots.find((slot) => slot.visitor)?.visitor!
    const visitorId = visitor.id
    visitor.commission = {
      ...visitor.commissionOptions[0]!, id: 'contract-a', status: 'active',
      startedAt: initial.updatedAt, finishesAt: initial.updatedAt, outcomeRoll: 0.5
    }
    visitor.state = 'commissioned'
    initial.expeditionsById['expedition-a'] = { id: 'expedition-a', itemIds: [], projection: { kind: 'expedition', visitorId, contractId: visitor.commission.id, startsAt: initial.updatedAt } }
    document = initial
    await transitionItemAtomic('atomic-user', 'loan-authoritative', 0, { operation: 'loan', itemId, targetId: 'expedition-a' })
    await expect(transitionItemAtomic('atomic-user', 'wrong-return', 1, { operation: 'return', itemId, targetId: 'expedition-b' }))
      .rejects.toBeInstanceOf(ItemTransitionError)
  })

  it('uses effective caravan ownership when admitting a commission reward', async () => {
    const { buildPersistedFromPublic, mutateSaveGameAtomic } = await import('../server/utils/savegame')
    const { applyItemTransition } = await import('../server/domain/item-transitions')
    const { claimVisitorCommission } = await import('../utils/visitor-logic')
    const save = createSaveGame('atomic-user')
    const visitor = save.visitRound.slots.find((slot) => slot.visitor)?.visitor!
    visitor.state = 'returned'
    visitor.commission = {
      ...visitor.commissionOptions[0]!, id: 'capacity-commission', status: 'ready',
      startedAt: '2026-09-13T00:00:00.000Z', finishesAt: '2026-09-13T00:01:00.000Z',
      outcomeRoll: 0.1, outcome: 'complete', rewardGold: visitor.commissionOptions[0]!.fullRewardGold,
      rewardItem: { ...structuredClone(save.stash[0]!), id: 'pending-capacity-reward' }
    }
    const initial = buildPersistedFromPublic(save)
    const templateId = initial.stash[0]!
    for (let index = initial.stash.length; index < initial.stashLimit - 1; index += 1) {
      const itemId = `capacity-item-${index}`
      initial.itemsById[itemId] = { ...structuredClone(initial.itemsById[templateId]!), id: itemId }
      initial.itemPlacements[itemId] = { ownerKind: 'caravan', custodyKind: 'stash' }
      initial.stash.push(itemId)
    }
    const loanedId = initial.stash[0]!
    document = applyItemTransition(initial, { operation: 'loan', itemId: loanedId, targetId: visitor.commission.id }).game

    const result = await mutateSaveGameAtomic('atomic-user', 'capacity-claim', 'claim:capacity', 0, {}, (draft) => {
      claimVisitorCommission(draft, visitor.id, new Date('2026-09-13T00:02:00.000Z'))
    })
    expect(result.stash).toHaveLength(initial.stashLimit - 1)
    const generatedReward = result.stash.find((item) => item.id.startsWith('loot-'))
    expect(generatedReward).toBeDefined()
    expect((document as PersistedGameV3).itemV2ById[generatedReward!.id]?.provenance).toMatchObject({
      zoneId: visitor.commission.regionId,
      businessKey: `loot:${visitor.commission.id}:reward`,
      configVersion: LOOT_CONFIG_VERSION
    })
    expect(Object.keys((document as PersistedGameV3).itemsById)).toHaveLength(Object.keys(initial.itemsById).length)
  })

  it('persists assignment, pending settlement projection, and exact reward claim', async () => {
    const { getPersistedGameV3, getSaveGame, mutateSaveGameAtomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const { assignVisitorCommission, claimVisitorCommission } = await import('../utils/visitor-logic')
    const initial = await getPersistedGameV3('atomic-user')
    const visitorId = initial.visitRound.slots.find((slot) => slot.visitor)?.visitor?.id!
    const start = new Date('2026-09-13T00:00:00.000Z')
    const dependencies = { now: () => start, random: () => 0, uuid: () => 'pending-flow' }

    await mutateSaveGameAtomic('atomic-user', 'assign-flow', 'commission:assign:flow', 0, {}, (save) => {
      const visitor = save.visitRound.slots.find((slot) => slot.visitor?.id === visitorId)!.visitor!
      visitor.state = 'traded'
      assignVisitorCommission(save, visitorId, 'safe', () => 0, start)
    }, dependencies)
    const assigned = await getPersistedGameV3('atomic-user')
    const assignedCommission = assigned.visitRound.slots.find((slot) => slot.visitor?.id === visitorId)!.visitor!.commission!
    expect(assigned.expeditionsById[assignedCommission.id]).toBeDefined()
    expect(assigned.settlementsById[assignedCommission.id]).toBeUndefined()
    const finish = assignedCommission.finishesAt
    const reconcileDependencies = { ...dependencies, now: () => new Date(finish) }
    const reconciledPublic = await getSaveGame('atomic-user', reconcileDependencies)

    const ready = await getPersistedGameV3('atomic-user')
    const readyVisitor = ready.visitRound.slots.find((slot) => slot.visitor?.id === visitorId)!.visitor!
    const rewardItemId = readyVisitor.commission!.rewardItemId!
    const rewardState = ready.itemV2ById[rewardItemId]!
    const publicRewardId = reconciledPublic.visitRound.slots.find((slot) => slot.visitor?.id === visitorId)?.visitor?.commission?.rewardItem?.id
    const view = mapPersistedGameToGameView(ready, new Date(finish))
    expect(publicRewardId).toBe(rewardItemId)
    expect(ready.itemPlacements[rewardItemId]).toEqual({ ownerKind: 'caravan', custodyKind: 'settlement', custodyId: readyVisitor.commission!.id })
    expect(rewardState).toMatchObject({
      sealedAffixes: ready.itemsById[rewardItemId]!.affixes,
      provenance: {
        zoneId: readyVisitor.commission!.regionId,
        configVersion: LOOT_CONFIG_VERSION,
        businessKey: `loot:${readyVisitor.commission!.id}:reward`,
        droppedAt: finish
      }
    })
    expect(view.settlements).toContainEqual(expect.objectContaining({ settlementId: readyVisitor.commission!.id }))
    expect(view.items).toContainEqual(expect.objectContaining({ itemId: rewardItemId, custody: expect.objectContaining({ kind: 'settlement' }) }))

    await mutateSaveGameAtomic('atomic-user', 'claim-flow', 'commission:claim:flow', ready.revision, {}, (save) => {
      claimVisitorCommission(save, visitorId, new Date(finish))
    }, reconcileDependencies)
    const claimed = await getPersistedGameV3('atomic-user')
    expect(claimed.stash.filter((itemId) => itemId === rewardItemId)).toHaveLength(1)
    expect(claimed.itemPlacements[rewardItemId]).toEqual({ ownerKind: 'caravan', custodyKind: 'stash' })
    expect(Object.entries(claimed.itemV2ById).filter(([, state]) => state.provenance?.businessKey === `loot:${readyVisitor.commission!.id}:reward`))
      .toHaveLength(1)
    expect(claimed.expeditionsById[readyVisitor.commission!.id]).toBeDefined()
  })

  it('recovers an exact replay when replaceOne throws after committing', async () => {
    const { mutateSaveGameAtomic } = await import('../server/utils/savegame')
    const original = collection.replaceOne.getMockImplementation()!
    collection.replaceOne.mockImplementationOnce(async (...args: Parameters<typeof original>) => {
      await original(...args)
      throw new Error('simulated network loss after commit')
    })
    const mutate = vi.fn((save: SaveGame) => { save.gold += 11 })
    const result = await mutateSaveGameAtomic('atomic-user', 'thrown-uncertain', 'credit:thrown', 0, { amount: 11 }, mutate)
    expect(result.gold).toBe(461)
    expect(mutate).toHaveBeenCalledOnce()
  })

  it('removes completed appraiser custody before persisting', async () => {
    const { mutateSaveGameAtomic } = await import('../server/utils/savegame')
    const { completeAppraisalQueue } = await import('../utils/game-logic')
    await mutateSaveGameAtomic('atomic-user', 'queue-job', 'queue:job-1', 0, {}, (save) => {
      const item = save.stash[0]!
      item.identified = false
      item.rarity = 'rare'
      save.caravan.services.appraiserQueue.push({
        id: 'job-1', itemId: item.id,
        startedAt: '2026-09-13T00:00:00.000Z',
        finishesAt: '2026-09-13T00:01:00.000Z'
      })
    })
    await mutateSaveGameAtomic(
      'atomic-user', 'complete-job', JSON.stringify(['appraise-complete']), 1, {},
      (save, deps) => completeAppraisalQueue(save, deps.now(), deps.random),
      { now: () => new Date('2026-09-13T00:02:00.000Z'), random: () => 0.25, uuid: () => 'uuid' }
    )
    expect((document as PersistedGameV3).caravan.services.appraiserQueue).toEqual([])
    expect((document as PersistedGameV3).serviceJobsById).toEqual({})
  })

  it('retains every permanent ledger key and at least 30 days of replay records', async () => {
    const { mutateSaveGameAtomic, sanitizeGameResponse } = await import('../server/utils/savegame')
    const persisted = document as PersistedGameV3
    const replayResponse = sanitizeGameResponse(createSaveGame('atomic-user'))
    replayResponse.revision = 1
    for (let index = 0; index < 510; index += 1) {
      const businessKey = `historic:${index}`
      persisted.businessKeys[businessKey] = `historic-request-${index}`
      persisted.ledger.push({
        at: '2026-07-01T00:00:00.000Z', requestId: `historic-request-${index}`,
        operationKey: businessKey, commandHash: 'a'.repeat(64), businessKey,
        revision: index + 1, goldDelta: 0, materialDeltas: {}, itemChanges: []
      })
    }
    persisted.revision = 510
    const recentResponse = structuredClone(replayResponse)
    recentResponse.revision = 2
    persisted.requestRecords.push(
      { requestId: 'historic-request-0', operationKey: 'historic:0', businessKey: 'historic:0', commandHash: 'a'.repeat(64), response: replayResponse as never, revision: 1, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' },
      { requestId: 'historic-request-1', operationKey: 'historic:1', businessKey: 'historic:1', commandHash: 'a'.repeat(64), response: recentResponse as never, revision: 2, createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z' }
    )
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-13T00:00:00.000Z'))
    try {
      await mutateSaveGameAtomic('atomic-user', 'fresh', 'fresh:key', 510, {}, () => {})
    } finally {
      vi.useRealTimers()
    }
    expect((document as PersistedGameV3).ledger).toHaveLength(511)
    expect((document as PersistedGameV3).requestRecords.map((entry) => entry.requestId)).toEqual(['historic-request-1', 'fresh'])
  })

  it('caps shared replay records across legacy, item transition, and equipment writers', async () => {
    const { mutateEquipmentV2Atomic, mutateSaveGameAtomic, sanitizeGameResponse, transitionItemAtomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const persisted = document as PersistedGameV3
    const baseResponse = sanitizeGameResponse(createSaveGame('atomic-user'))
    persisted.requestRecords = []
    persisted.ledger = []
    persisted.businessKeys = {}
    for (let index = 0; index < 120; index += 1) {
      const requestId = `historic-request-${index}`
      const operationKey = `historic-operation-${index}`
      const businessKey = `historic-key-${index}`
      const commandHash = 'a'.repeat(64)
      const response = structuredClone(baseResponse)
      response.revision = index + 1
      persisted.businessKeys[businessKey] = requestId
      persisted.ledger.push({
        at: '2026-09-01T00:00:00.000Z',
        requestId,
        operationKey,
        commandHash,
        businessKey,
        revision: index + 1,
        goldDelta: 0,
        materialDeltas: {},
        itemChanges: []
      })
      persisted.requestRecords.push({
        requestId,
        operationKey,
        businessKey,
        commandHash,
        response,
        revision: index + 1,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z'
      })
    }
    persisted.revision = 120
    document = persisted
    const deps = fixedDeps(new Date('2026-09-15T12:00:00.000Z'))

    await mutateSaveGameAtomic('atomic-user', 'legacy-fresh', 'legacy:fresh', 120, {}, (save) => { save.gold += 1 }, deps)
    expect((document as PersistedGameV3).requestRecords).toHaveLength(100)

    const afterLegacy = document as PersistedGameV3
    const soldItemId = afterLegacy.stash[0]!
    const visitorId = afterLegacy.visitRound.slots.find((slot) => slot.visitor)?.visitor?.id!
    await transitionItemAtomic('atomic-user', 'transition-fresh', 121, { operation: 'sell', itemId: soldItemId, targetId: visitorId }, deps)
    expect((document as PersistedGameV3).requestRecords).toHaveLength(100)

    const afterTransition = document as PersistedGameV3
    const itemId = afterTransition.stash[0]!
    afterTransition.itemsById[itemId]!.identified = false
    afterTransition.itemsById[itemId]!.rarity = 'magic'
    document = afterTransition
    const identify = executionOption(mapPersistedGameToGameView(afterTransition, deps.now()), itemId, 'identify_item')
    await mutateEquipmentV2Atomic('atomic-user', 'equipment-fresh', 122, {
      action: 'identify_item', itemId, optionId: identify.optionId
    }, deps)

    const final = document as PersistedGameV3
    expect(final.requestRecords).toHaveLength(100)
    expect(final.ledger).toHaveLength(123)
    expect(Object.keys(final.businessKeys)).toHaveLength(123)
    expect(final.requestRecords.map((entry) => entry.requestId)).toEqual(expect.arrayContaining(['legacy-fresh', 'transition-fresh', 'equipment-fresh']))
    expect(final.requestRecords.some((entry) => entry.requestId === 'historic-request-0')).toBe(false)
  })

  it('resets schema 2 with CAS while preserving only user identity', async () => {
    const { getSaveGame } = await import('../server/utils/savegame')
    document = { userId: 'atomic-user', schemaVersion: 2, revision: 8, gold: 999_999, heroes: [{ id: 'old' }] }
    const reset = await getSaveGame('atomic-user')
    expect(reset.gold).toBe(450)
    expect(reset.revision).toBe(9)
    expect(reset).not.toHaveProperty('heroes')
    expect((document as unknown as PersistedGameV3).itemsById).toBeDefined()
  })

  it('rejects corrupt schema 3 instead of normalizing it', async () => {
    const { getSaveGame, PersistedGameCorruptError } = await import('../server/utils/savegame')
    document = { userId: 'atomic-user', schemaVersion: 3, revision: 0, gold: 450 }
    await expect(getSaveGame('atomic-user')).rejects.toBeInstanceOf(PersistedGameCorruptError)
  })

  it('rejects legacy fields on a document that declares schema 3', async () => {
    const { getSaveGame, PersistedGameCorruptError } = await import('../server/utils/savegame')
    document = { ...(document as PersistedGameV3), heroes: [], processedRequests: [] }
    await expect(getSaveGame('atomic-user')).rejects.toBeInstanceOf(PersistedGameCorruptError)
  })

  it('applies V2 identification through the persisted aggregate without rerolling sealed affixes', async () => {
    const { getPersistedGameV3, mutateEquipmentV2Atomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3('atomic-user')
    const itemId = initial.stash[0]!
    initial.itemsById[itemId]!.identified = false
    initial.itemsById[itemId]!.rarity = 'magic'
    initial.itemsById[itemId]!.affixes = [{ stat: 'attackPower', value: 7 }]
    document = initial

    const view = mapPersistedGameToGameView(initial, new Date('2026-09-15T12:00:00.000Z'))
    const identify = executionOption(view, itemId, 'identify_item')
    expect(view.items).toContainEqual(expect.objectContaining({
      itemId,
      identification: 'unidentified',
      actions: expect.arrayContaining([expect.objectContaining({ action: 'identify_item', enabled: true })])
    }))
    const identified = await mutateEquipmentV2Atomic('atomic-user', 'identify-v2', 0, {
      action: 'identify_item', itemId, optionId: identify.optionId
    }, fixedDeps())

    expect(identified.gold).toBe(initial.gold - 50)
    expect(identified.itemsById[itemId]!.identified).toBe(true)
    expect(identified.itemsById[itemId]!.affixes).toEqual([{ stat: 'attackPower', value: 7 }])
    expect(identified.itemV2ById[itemId]!.sealedAffixes).toEqual([{ stat: 'attackPower', value: 7 }])
  })

  it('queues and completes deterministic artisan service jobs exactly once', async () => {
    const { getPersistedGameV3, mutateEquipmentV2Atomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3('atomic-user')
    const itemId = initial.stash[0]!
    document = initial
    const blacksmith = executionOption(mapPersistedGameToGameView(initial), itemId, 'queue_blacksmith_job')

    const queued = await mutateEquipmentV2Atomic('atomic-user', 'blacksmith-v2', 0, {
      action: 'queue_blacksmith_job', itemId, optionId: blacksmith.optionId
    }, fixedDeps())
    const jobId = Object.keys(queued.serviceJobsById).find((id) => id.startsWith('blacksmith-'))!
    expect(queued.itemPlacements[itemId]).toEqual({ ownerKind: 'caravan', custodyKind: 'service', custodyId: jobId })
    expect(queued.serviceJobStateById[jobId]).toMatchObject({ status: 'active', itemId, result: { blacksmithLevel: 1 } })

    const completed = await mutateEquipmentV2Atomic('atomic-user', 'complete-blacksmith-v2', 1, {
      action: 'complete_service_job', jobId
    }, fixedDeps(new Date('2026-09-15T12:02:00.000Z')))
    expect(completed.itemPlacements[itemId]).toEqual({ ownerKind: 'caravan', custodyKind: 'stash' })
    expect(completed.itemV2ById[itemId]!.blacksmithLevel).toBe(1)
    expect(completed.serviceJobStateById[jobId]!.status).toBe('completed')
  })

  it('publishes and accepts contractual unidentified artisan and dismantle actions without revealing affixes', async () => {
    const { getPersistedGameV3, mutateEquipmentV2Atomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3('atomic-user')
    const itemId = initial.stash[0]!
    initial.itemsById[itemId]!.identified = false
    initial.itemsById[itemId]!.rarity = 'rare'
    initial.itemsById[itemId]!.affixes = [{ stat: 'attackPower', value: 9 }]
    document = initial

    const view = mapPersistedGameToGameView(initial, new Date('2026-09-15T12:00:00.000Z'))
    const projected = view.items.find((item) => (item as { itemId?: string }).itemId === itemId) as { actions: Array<{ action: string }>; affixes?: unknown } | undefined
    expect(projected).toMatchObject({ identification: 'unidentified' })
    expect(projected?.affixes).toBeUndefined()
    expect(projected?.actions.map((action) => action.action)).toEqual(expect.arrayContaining([
      'identify_item', 'queue_blacksmith_job', 'queue_enchanter_job', 'dismantle_item'
    ]))

    const blacksmith = executionOption(view, itemId, 'queue_blacksmith_job')
    const queued = await mutateEquipmentV2Atomic('atomic-user', 'blacksmith-unidentified', 0, {
      action: 'queue_blacksmith_job', itemId, optionId: blacksmith.optionId
    }, fixedDeps())

    expect(queued.serviceJobStateById[Object.keys(queued.serviceJobStateById)[0]!]!.status).toBe('active')
    expect(queued.itemsById[itemId]!.identified).toBe(false)
  })

  it('dismantles to materials without crediting gold', async () => {
    const { getPersistedGameV3, mutateEquipmentV2Atomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3('atomic-user')
    const itemId = initial.stash[0]!
    const startingGold = initial.gold
    document = initial
    const dismantle = executionOption(mapPersistedGameToGameView(initial), itemId, 'dismantle_item')

    const dismantled = await mutateEquipmentV2Atomic('atomic-user', 'dismantle-v2', 0, {
      action: 'dismantle_item',
      itemId,
      optionId: dismantle.optionId,
      acknowledgementId: dismantle.acknowledgementId
    }, fixedDeps())

    expect(dismantled.gold).toBe(startingGold)
    expect(dismantled.materials.scrap).toBeGreaterThan(0)
    expect(dismantled.itemPlacements[itemId]).toEqual({ ownerKind: 'tombstone', custodyKind: 'tombstone', custodyId: `dismantle-${itemId}` })
  })

  it('keeps one active boss imprint and appends replacement history', async () => {
    const { getPersistedGameV3, mutateEquipmentV2Atomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3('atomic-user')
    const itemId = initial.stash[0]!
    initial.itemV2ById[itemId] = {
      activeImprint: { imprintId: 'old-boss', label: 'Old boss', grantedAt: initial.createdAt },
      pendingImprint: { imprintId: 'new-boss', label: 'New boss', grantedAt: initial.updatedAt }
    }
    document = initial
    const imprint = executionOption(mapPersistedGameToGameView(initial), itemId, 'replace_boss_imprint')

    const replaced = await mutateEquipmentV2Atomic('atomic-user', 'imprint-v2', 0, {
      action: 'replace_boss_imprint',
      itemId,
      optionId: imprint.optionId,
      acknowledgementId: imprint.acknowledgementId
    }, fixedDeps())

    expect(replaced.itemV2ById[itemId]!.activeImprint?.imprintId).toBe('new-boss')
    expect(replaced.itemV2ById[itemId]!.pendingImprint).toBeUndefined()
    expect(replaced.itemV2ById[itemId]!.imprintHistory).toEqual([
      { imprintId: 'old-boss', label: 'Old boss', grantedAt: initial.createdAt, replacedAt: '2026-09-15T12:00:00.000Z' }
    ])
  })

  it('backfills equipment V2 maps on existing canonical V3 saves before direct equipment POST mutations', async () => {
    const { mutateEquipmentV2Atomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const legacyV3 = structuredClone(document as PersistedGameV3) as Omit<PersistedGameV3, 'itemV2ById' | 'serviceJobStateById'>
    const itemId = legacyV3.stash[0]!
    legacyV3.itemsById[itemId]!.identified = false
    legacyV3.itemsById[itemId]!.rarity = 'magic'
    const identify = executionOption(mapPersistedGameToGameView(legacyV3 as PersistedGameV3, new Date('2026-09-15T12:00:00.000Z')), itemId, 'identify_item')
    delete (legacyV3 as Partial<PersistedGameV3>).itemV2ById
    delete (legacyV3 as Partial<PersistedGameV3>).serviceJobStateById
    document = legacyV3 as unknown as PersistedGameV3

    const mutated = await mutateEquipmentV2Atomic('atomic-user', 'identify-pre-map-v3', 0, {
      action: 'identify_item', itemId, optionId: identify.optionId
    }, fixedDeps())

    expect(mutated.itemsById[itemId]!.identified).toBe(true)
    expect(collection.replaceOne).toHaveBeenCalledTimes(2)
  })

  it('signs equipment capabilities with the effective runtime secret instead of the public dev fallback', async () => {
    const { EquipmentV2Error } = await import('../server/domain/equipment-v2')
    const { getPersistedGameV3, mutateEquipmentV2Atomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    delete process.env.JWT_SECRET
    process.env.NUXT_JWT_SECRET = 'effective-nuxt-secret'
    const initial = await getPersistedGameV3('atomic-user')
    const itemId = initial.stash[0]!
    initial.itemsById[itemId]!.identified = false
    document = initial
    const identify = executionOption(mapPersistedGameToGameView(initial, new Date('2026-09-15T12:00:00.000Z')), itemId, 'identify_item')

    process.env.NUXT_JWT_SECRET = 'different-effective-secret'
    await expect(mutateEquipmentV2Atomic('atomic-user', 'wrong-secret', 0, {
      action: 'identify_item', itemId, optionId: identify.optionId
    }, fixedDeps())).rejects.toBeInstanceOf(EquipmentV2Error)

    process.env.NUXT_JWT_SECRET = 'effective-nuxt-secret'
    await expect(mutateEquipmentV2Atomic('atomic-user', 'right-secret', 0, {
      action: 'identify_item', itemId, optionId: identify.optionId
    }, fixedDeps())).resolves.toMatchObject({ revision: 1 })
  })

  it('rejects absent foreign fabricated expired and mixed equipment capabilities', async () => {
    const { EquipmentV2Error } = await import('../server/domain/equipment-v2')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const { getPersistedGameV3, mutateEquipmentV2Atomic } = await import('../server/utils/savegame')
    const initial = await getPersistedGameV3('atomic-user')
    const [firstItemId, secondItemId] = initial.stash
    if (!firstItemId || !secondItemId) throw new Error('fixture needs two stash items')
    document = initial
    const view = mapPersistedGameToGameView(initial, new Date('2026-09-15T12:00:00.000Z'))
    const first = executionOption(view, firstItemId, 'dismantle_item')
    const second = executionOption(view, secondItemId, 'dismantle_item')
    const forged = `${first.optionId.slice(0, -1)}${first.optionId.endsWith('a') ? 'b' : 'a'}`

    await expect(mutateEquipmentV2Atomic('atomic-user', 'missing-ack', 0, {
      action: 'dismantle_item', itemId: firstItemId, optionId: first.optionId
    }, fixedDeps())).rejects.toBeInstanceOf(EquipmentV2Error)
    await expect(mutateEquipmentV2Atomic('atomic-user', 'foreign-option', 0, {
      action: 'dismantle_item', itemId: firstItemId, optionId: second.optionId, acknowledgementId: first.acknowledgementId
    }, fixedDeps())).rejects.toBeInstanceOf(EquipmentV2Error)
    await expect(mutateEquipmentV2Atomic('atomic-user', 'mixed-ack', 0, {
      action: 'dismantle_item', itemId: firstItemId, optionId: first.optionId, acknowledgementId: second.acknowledgementId
    }, fixedDeps())).rejects.toBeInstanceOf(EquipmentV2Error)
    await expect(mutateEquipmentV2Atomic('atomic-user', 'forged-option', 0, {
      action: 'dismantle_item', itemId: firstItemId, optionId: forged, acknowledgementId: first.acknowledgementId
    }, fixedDeps())).rejects.toBeInstanceOf(EquipmentV2Error)
    await expect(mutateEquipmentV2Atomic('atomic-user', 'expired-token', 0, {
      action: 'dismantle_item', itemId: firstItemId, optionId: first.optionId, acknowledgementId: first.acknowledgementId
    }, fixedDeps(new Date('2026-09-15T12:05:00.000Z')))).rejects.toBeInstanceOf(EquipmentV2Error)
  })

  it('publishes fresh equipment action expirations after inactivity and on old replay snapshots', async () => {
    const { getPersistedGameV3, mutateEquipmentV2Atomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3('atomic-user')
    const itemId = initial.stash[0]!
    initial.itemsById[itemId]!.identified = false
    initial.itemsById[itemId]!.rarity = 'magic'
    initial.updatedAt = '2026-09-15T12:00:00.000Z'
    document = initial

    const inactiveView = mapPersistedGameToGameView(initial, new Date('2026-09-15T12:10:00.000Z'))
    const inactiveOption = executionOption(inactiveView, itemId, 'identify_item')
    expect(Date.parse(inactiveOption.expiresAt)).toBeGreaterThan(Date.parse(inactiveView.serverNow))

    const identified = await mutateEquipmentV2Atomic('atomic-user', 'identify-inactive-replay', 0, {
      action: 'identify_item', itemId, optionId: inactiveOption.optionId
    }, fixedDeps(new Date('2026-09-15T12:10:00.000Z')))
    const replay = await mutateEquipmentV2Atomic('atomic-user', 'identify-inactive-replay', 99, {
      action: 'identify_item', itemId, optionId: inactiveOption.optionId
    }, fixedDeps(new Date('2026-09-15T12:20:00.000Z')))
    const replayView = mapPersistedGameToGameView(replay, new Date('2026-09-15T12:20:00.000Z'))
    const secondItemId = replay.stash.find((id) => id !== itemId)!
    const replayOption = executionOption(replayView, secondItemId, 'dismantle_item')

    expect(replay.revision).toBe(identified.revision)
    expect(Date.parse(replayOption.expiresAt)).toBeGreaterThan(Date.parse(replayView.serverNow))
  })

  it('keeps equipment replay snapshots bounded across command sequences', async () => {
    const { getPersistedGameV3, hydratePersistedGame, mutateEquipmentV2Atomic, sanitizeGameResponse } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3('atomic-user')
    const firstItemId = initial.stash[0]
    if (!firstItemId) throw new Error('fixture needs one stash item')
    initial.itemsById[firstItemId]!.identified = false
    initial.itemsById[firstItemId]!.rarity = 'magic'
    initial.revision = 130
    const response = sanitizeGameResponse(hydratePersistedGame(initial))
    for (let index = 1; index <= 130; index += 1) {
      const requestId = `historic-${index}`
      const businessKey = `historic-business-${index}`
      const operationKey = `historic-operation-${index}`
      const commandHash = `${String(index % 10)}`.repeat(64)
      initial.requestRecords.push({
        requestId,
        operationKey,
        businessKey,
        commandHash,
        response: { ...structuredClone(response), revision: index },
        revision: index,
        createdAt: index <= 20 ? '2026-08-01T12:00:00.000Z' : '2026-09-15T12:00:00.000Z',
        updatedAt: '2026-09-15T12:00:00.000Z'
      })
      initial.businessKeys[businessKey] = requestId
      initial.ledger.push({
        at: '2026-09-15T12:00:00.000Z',
        requestId,
        operationKey,
        commandHash,
        businessKey,
        revision: index,
        goldDelta: 0,
        materialDeltas: {},
        itemChanges: []
      })
    }
    document = initial

    const first = executionOption(mapPersistedGameToGameView(initial, new Date('2026-09-15T12:00:00.000Z')), firstItemId, 'identify_item')
    await mutateEquipmentV2Atomic('atomic-user', 'bounded-one', 130, {
      action: 'identify_item', itemId: firstItemId, optionId: first.optionId
    }, fixedDeps())

    const records = (document as PersistedGameV3).requestRecords
    expect(records).toHaveLength(100)
    expect(records.some((record) => record.requestId === 'historic-1')).toBe(false)
    expect(records.at(-1)?.requestId).toBe('bounded-one')
    expect(records.every((record) => record.persistedResponse === undefined || record.persistedResponse.requestRecords.length === 0)).toBe(true)
    expect((document as PersistedGameV3).businessKeys['historic-business-1']).toBe('historic-1')
    expect((document as PersistedGameV3).ledger.some((entry) => entry.requestId === 'historic-1')).toBe(true)
  })

  it('replays the committed equipment snapshot after a later mutation', async () => {
    const { getPersistedGameV3, mutateEquipmentV2Atomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3('atomic-user')
    const [firstItemId, secondItemId] = initial.stash
    if (!firstItemId || !secondItemId) throw new Error('fixture needs two stash items')
    initial.itemsById[firstItemId]!.identified = false
    initial.itemsById[firstItemId]!.rarity = 'magic'
    document = initial
    const identify = executionOption(mapPersistedGameToGameView(initial), firstItemId, 'identify_item')
    const first = await mutateEquipmentV2Atomic('atomic-user', 'identify-replay', 0, {
      action: 'identify_item', itemId: firstItemId, optionId: identify.optionId
    }, fixedDeps())
    const dismantle = executionOption(mapPersistedGameToGameView(document as PersistedGameV3), secondItemId, 'dismantle_item')
    await mutateEquipmentV2Atomic('atomic-user', 'later-dismantle', 1, {
      action: 'dismantle_item', itemId: secondItemId, optionId: dismantle.optionId, acknowledgementId: dismantle.acknowledgementId
    }, fixedDeps())

    const replay = await mutateEquipmentV2Atomic('atomic-user', 'identify-replay', 99, {
      action: 'identify_item', itemId: firstItemId, optionId: identify.optionId
    }, fixedDeps())

    expect(replay.revision).toBe(first.revision)
    expect(replay.itemPlacements[secondItemId]).toEqual(first.itemPlacements[secondItemId])
  })

  it('reconciles due service jobs and allows exact and new-request completion retries', async () => {
    const { getPersistedGameV3, mutateEquipmentV2Atomic, reconcilePersistedGameV3 } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3('atomic-user')
    const itemId = initial.stash[0]!
    document = initial
    const blacksmith = executionOption(mapPersistedGameToGameView(initial), itemId, 'queue_blacksmith_job')
    const queued = await mutateEquipmentV2Atomic('atomic-user', 'queue-reconcile', 0, {
      action: 'queue_blacksmith_job', itemId, optionId: blacksmith.optionId
    }, fixedDeps())
    const jobId = Object.keys(queued.serviceJobStateById)[0]!

    const reconciled = await reconcilePersistedGameV3('atomic-user', fixedDeps(new Date('2026-09-15T12:02:00.000Z')))
    const replay = await mutateEquipmentV2Atomic('atomic-user', `complete-service:${jobId}:2026-09-15T12:01:00.000Z`, 1, {
      action: 'complete_service_job', jobId
    }, fixedDeps(new Date('2026-09-15T12:02:00.000Z')))
    const newRequest = await mutateEquipmentV2Atomic('atomic-user', 'complete-service-new-request', 2, {
      action: 'complete_service_job', jobId
    }, fixedDeps(new Date('2026-09-15T12:02:00.000Z')))

    expect(reconciled.serviceJobStateById[jobId]!.status).toBe('completed')
    expect(replay.revision).toBe(reconciled.revision)
    expect(newRequest.revision).toBe(reconciled.revision)
    expect((document as PersistedGameV3).serviceJobsById[jobId]!.itemIds).toEqual([])
  })

  it('reconciles more than five due service jobs in one pass', async () => {
    const { getPersistedGameV3, reconcilePersistedGameV3, isPersistedCanonical } = await import('../server/utils/savegame')
    const initial = await getPersistedGameV3('atomic-user')
    const templateId = initial.stash[0]!
    for (let index = 0; index < 6; index += 1) {
      const itemId = `due-item-${index}`
      const jobId = `due-job-${index}`
      initial.itemsById[itemId] = { ...structuredClone(initial.itemsById[templateId]!), id: itemId, identified: true }
      initial.itemPlacements[itemId] = { ownerKind: 'caravan', custodyKind: 'service', custodyId: jobId }
      initial.serviceJobsById[jobId] = {
        id: jobId,
        itemIds: [itemId],
        projection: { kind: 'service', service: 'blacksmith', queuedAt: '2026-09-15T12:00:00.000Z', startsAt: '2026-09-15T12:00:00.000Z' }
      }
      initial.serviceJobStateById[jobId] = {
        status: 'active',
        service: 'blacksmith',
        itemId,
        queuedAt: '2026-09-15T12:00:00.000Z',
        startedAt: '2026-09-15T12:00:00.000Z',
        completesAt: '2026-09-15T12:01:00.000Z',
        result: { blacksmithLevel: index + 1 }
      }
    }
    document = initial
    expect(isPersistedCanonical(initial)).toBe(true)

    const reconciled = await reconcilePersistedGameV3('atomic-user', fixedDeps(new Date('2026-09-15T12:02:00.000Z')))

    expect(Object.values(reconciled.serviceJobStateById).every((state) => state.status === 'completed')).toBe(true)
    expect(reconciled.stash.filter((itemId) => itemId.startsWith('due-item-'))).toHaveLength(6)
    expect(reconciled.revision).toBe(6)
  })

  it('rejects corrupt service job invariants and terminal completion', async () => {
    const { EquipmentV2Error } = await import('../server/domain/equipment-v2')
    const { getPersistedGameV3, isPersistedCanonical, mutateEquipmentV2Atomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3('atomic-user')
    const itemId = initial.stash[0]!
    document = initial
    const blacksmith = executionOption(mapPersistedGameToGameView(initial), itemId, 'queue_blacksmith_job')
    const queued = await mutateEquipmentV2Atomic('atomic-user', 'queue-corrupt', 0, {
      action: 'queue_blacksmith_job', itemId, optionId: blacksmith.optionId
    }, fixedDeps())
    const jobId = Object.keys(queued.serviceJobStateById)[0]!
    const corrupt = structuredClone(queued)
    corrupt.serviceJobsById[jobId]!.itemIds = []
    expect(isPersistedCanonical(corrupt)).toBe(false)
    const missingState = structuredClone(queued)
    delete missingState.serviceJobStateById[jobId]
    expect(isPersistedCanonical(missingState)).toBe(false)
    const divergentProjection = structuredClone(queued)
    divergentProjection.serviceJobsById[jobId]!.projection = {
      kind: 'service',
      service: 'blacksmith',
      queuedAt: '2026-09-15T11:00:00.000Z',
      startsAt: '2026-09-15T11:00:00.000Z'
    }
    expect(isPersistedCanonical(divergentProjection)).toBe(false)

    const terminal = structuredClone(queued)
    terminal.serviceJobStateById[jobId]!.status = 'failed'
    terminal.serviceJobStateById[jobId]!.failedAt = '2026-09-15T12:02:00.000Z'
    terminal.serviceJobsById[jobId]!.itemIds = []
    terminal.itemPlacements[itemId] = { ownerKind: 'caravan', custodyKind: 'stash' }
    terminal.stash = [itemId, ...terminal.stash]
    document = terminal
    await expect(mutateEquipmentV2Atomic('atomic-user', 'complete-failed', 1, {
      action: 'complete_service_job', jobId
    }, fixedDeps(new Date('2026-09-15T12:02:00.000Z')))).rejects.toBeInstanceOf(EquipmentV2Error)
  })

  it('projects queued service job timestamps from authoritative state', async () => {
    const { getPersistedGameV3 } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3('atomic-user')
    const itemId = initial.stash[0]!
    const jobId = 'queued-job'
    initial.stash = initial.stash.filter((candidate) => candidate !== itemId)
    initial.itemPlacements[itemId] = { ownerKind: 'caravan', custodyKind: 'service', custodyId: jobId }
    initial.serviceJobsById[jobId] = {
      id: jobId,
      itemIds: [itemId],
      projection: { kind: 'service', service: 'blacksmith', queuedAt: '2026-09-15T10:00:00.000Z', startsAt: '2026-09-15T10:05:00.000Z' }
    }
    initial.serviceJobStateById[jobId] = {
      status: 'queued',
      service: 'blacksmith',
      itemId,
      queuedAt: '2026-09-15T12:00:00.000Z',
      startedAt: '2026-09-15T12:05:00.000Z',
      completesAt: '2026-09-15T12:06:00.000Z',
      result: { blacksmithLevel: 1 }
    }

    const view = mapPersistedGameToGameView(initial, new Date('2026-09-15T12:00:00.000Z'))

    expect(view.serviceJobs).toContainEqual(expect.objectContaining({
      jobId,
      state: 'queued',
      queuedAt: '2026-09-15T12:00:00.000Z',
      startsAt: '2026-09-15T12:05:00.000Z'
    }))
  })

  it('projects failed and cancelled service jobs as terminal states', async () => {
    const { getPersistedGameV3 } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3('atomic-user')
    const [failedItemId, cancelledItemId] = initial.stash
    if (!failedItemId || !cancelledItemId) throw new Error('fixture needs two stash items')
    initial.serviceJobsById.failed = {
      id: 'failed',
      itemIds: [],
      projection: { kind: 'service', service: 'enchanter', queuedAt: '2026-09-15T12:00:00.000Z', startsAt: '2026-09-15T12:00:00.000Z' }
    }
    initial.serviceJobStateById.failed = {
      status: 'failed',
      service: 'enchanter',
      itemId: failedItemId,
      queuedAt: '2026-09-15T12:00:00.000Z',
      startedAt: '2026-09-15T12:00:00.000Z',
      completesAt: '2026-09-15T12:01:00.000Z',
      failedAt: '2026-09-15T12:10:00.000Z',
      result: { enchantCount: 1, affix: { stat: 'life', value: 1 } }
    }
    initial.serviceJobsById.cancelled = {
      id: 'cancelled',
      itemIds: [],
      projection: { kind: 'service', service: 'blacksmith', queuedAt: '2026-09-15T12:00:00.000Z', startsAt: '2026-09-15T12:00:00.000Z' }
    }
    initial.serviceJobStateById.cancelled = {
      status: 'cancelled',
      service: 'blacksmith',
      itemId: cancelledItemId,
      queuedAt: '2026-09-15T12:00:00.000Z',
      startedAt: '2026-09-15T12:00:00.000Z',
      completesAt: '2026-09-15T12:01:00.000Z',
      cancelledAt: '2026-09-15T12:02:00.000Z',
      result: { blacksmithLevel: 1 }
    }
    document = initial

    const view = mapPersistedGameToGameView(initial, new Date('2026-09-15T12:02:00.000Z'))

    expect(view.serviceJobs).toContainEqual(expect.objectContaining({ jobId: 'failed', state: 'failed', failedAt: '2026-09-15T12:10:00.000Z' }))
    expect(view.serviceJobs).toContainEqual(expect.objectContaining({ jobId: 'cancelled', state: 'cancelled', cancelledAt: '2026-09-15T12:02:00.000Z' }))
  })

  it('allows a second legitimate imprint replacement with a new pending imprint token', async () => {
    const { getPersistedGameV3, mutateEquipmentV2Atomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3('atomic-user')
    const itemId = initial.stash[0]!
    initial.itemV2ById[itemId] = {
      activeImprint: { imprintId: 'old-boss', label: 'Old boss', grantedAt: initial.createdAt },
      pendingImprint: { imprintId: 'new-boss', label: 'New boss', grantedAt: initial.updatedAt }
    }
    document = initial
    const firstOption = executionOption(mapPersistedGameToGameView(initial), itemId, 'replace_boss_imprint')
    const first = await mutateEquipmentV2Atomic('atomic-user', 'imprint-first', 0, {
      action: 'replace_boss_imprint', itemId, optionId: firstOption.optionId, acknowledgementId: firstOption.acknowledgementId
    }, fixedDeps())
    first.itemV2ById[itemId]!.pendingImprint = { imprintId: 'third-boss', label: 'Third boss', grantedAt: '2026-09-15T12:03:00.000Z' }
    document = first
    const secondOption = executionOption(mapPersistedGameToGameView(first), itemId, 'replace_boss_imprint')

    const second = await mutateEquipmentV2Atomic('atomic-user', 'imprint-second', 1, {
      action: 'replace_boss_imprint', itemId, optionId: secondOption.optionId, acknowledgementId: secondOption.acknowledgementId
    }, fixedDeps(new Date('2026-09-15T12:03:00.000Z')))

    expect(second.itemV2ById[itemId]!.activeImprint?.imprintId).toBe('third-boss')
    expect(second.itemV2ById[itemId]!.imprintHistory?.map((entry) => entry.imprintId)).toEqual(['old-boss', 'new-boss'])
    expect(second.itemV2ById[itemId]!.imprintHistory?.every((entry) => entry.replacedAt)).toBe(true)
  })

  it('keeps the V2 action handler payload closed with stable 400 and 409 mappings', async () => {
    vi.resetModules()
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', (event: { context: { params: Record<string, string> } }, name: string) => event.context.params[name])
    vi.stubGlobal('readBody', async (event: { body: Record<string, unknown> }) => event.body)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.doMock('../server/utils/auth', () => ({ requireUser: async () => ({ id: 'atomic-user', email: 'atomic@example.test' }) }))
    vi.doMock('../server/domain/game-view', () => ({ mapPersistedGameToGameView: () => ({ ok: true }) }))
    class RevisionConflictError extends Error {}
    class IdempotencyConflictError extends Error {}
    class BusinessKeyConflictError extends Error {}
    class InvalidMutationRequestError extends Error {}
    const mutateEquipmentV2Atomic = vi.fn(async (_userId: string, requestId: string) => {
      if (requestId === 'too-long') throw new InvalidMutationRequestError('A valid requestId is required')
      if (requestId === 'stale') throw new RevisionConflictError('Save changed concurrently')
      return {} as PersistedGameV3
    })
    vi.doMock('../server/utils/savegame', () => ({
      mutateEquipmentV2Atomic,
      RevisionConflictError,
      IdempotencyConflictError,
      BusinessKeyConflictError,
      InvalidMutationRequestError
    }))
    const { default: handler } = await import('../server/api/v2/actions/[action].post')

    const valid = { requestId: 'ok', expectedRevision: 0, itemId: 'item-1', optionId: 'option-1' }
    await expect(handler({ context: { params: { action: 'identify_item' } }, body: { ...valid, extra: true } } as never))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(handler({ context: { params: { action: 'identify_item' } }, body: { requestId: 'missing', expectedRevision: 0, itemId: 'item-1' } } as never))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(handler({ context: { params: { action: 'identify_item' } }, body: { ...valid, requestId: 'stale' } } as never))
      .rejects.toMatchObject({ statusCode: 409 })
    await expect(handler({ context: { params: { action: 'identify_item' } }, body: valid } as never))
      .resolves.toEqual({ ok: true })
  })

  it('maps a 129 character requestId rejected by the production mutator to 400', async () => {
    vi.resetModules()
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', (event: { context: { params: Record<string, string> } }, name: string) => event.context.params[name])
    vi.stubGlobal('readBody', async (event: { body: Record<string, unknown> }) => event.body)
    vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
    vi.doMock('../server/utils/auth', () => ({ requireUser: async () => ({ id: 'atomic-user', email: 'atomic@example.test' }) }))
    vi.doUnmock('../server/domain/game-view')
    vi.doUnmock('../server/utils/savegame')
    const { default: handler } = await import('../server/api/v2/actions/[action].post')

    await expect(handler({
      context: { params: { action: 'identify_item' } },
      body: { requestId: 'x'.repeat(129), expectedRevision: 0, itemId: 'item-1', optionId: 'option-1' }
    } as never)).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('equipment V2 loot generation', () => {
  it('repeats identity affixes and provenance for the same injected seed sequence', () => {
    const first = generateLootForZone({
      zoneId: 'cold-plains',
      businessKey: 'loot:test-repeat',
      droppedAt: '2026-09-15T12:00:00.000Z'
    }, sequenceDeps([0.99, 0.1, 0.5, 0.9], ['repeat-id']))
    const second = generateLootForZone({
      zoneId: 'cold-plains',
      businessKey: 'loot:test-repeat',
      droppedAt: '2026-09-15T12:00:00.000Z'
    }, sequenceDeps([0.99, 0.1, 0.5, 0.9], ['repeat-id']))

    expect(second).toEqual(first)
    expect(first.item.id).toBe('loot-repeat-id')
    expect(first.state.sealedAffixes).toEqual(first.item.affixes)
    expect(first.state.provenance).toMatchObject({
      zoneId: 'cold-plains',
      lootTableId: 'act1-mid',
      configVersion: LOOT_CONFIG_VERSION,
      businessKey: 'loot:test-repeat',
      combinationId: 'wanderer-set',
      imperfectPieceId: 'cracked-gem'
    })
  })

  it('conserves generated item identity over deterministic property samples', () => {
    for (let seed = 0; seed < 24; seed += 1) {
      const randoms = Array.from({ length: 8 }, (_, index) => ((seed * 17 + index * 23) % 97) / 97)
      const generated = generateLootForZone({
        zoneId: seed % 2 === 0 ? 'blood-moor' : 'forgotten-tower',
        businessKey: `loot:property:${seed}`,
        droppedAt: '2026-09-15T12:00:00.000Z'
      }, sequenceDeps(randoms, [`property-${seed}`]))

      expect(generated.item.id).toBe(`loot-property-${seed}`)
      expect(generated.item.affixes).toEqual(generated.state.sealedAffixes)
      expect(generated.item.value).toBeGreaterThan(0)
      expect(generated.state.provenance?.businessKey).toBe(`loot:property:${seed}`)
      expect(generated.state.provenance?.configVersion).toBe(LOOT_CONFIG_VERSION)
    }
  })

  it('attaches a pending boss imprint to act boss loot', () => {
    const generated = generateLootForZone({
      zoneId: 'act-boss',
      businessKey: 'loot:boss',
      droppedAt: '2026-09-15T12:00:00.000Z'
    }, sequenceDeps([0.2, 0.3, 0.4, 0.5], ['boss-id']))

    expect(generated.state.pendingImprint).toEqual({
      imprintId: 'boss-act-boss',
      label: 'Act boss imprint',
      grantedAt: '2026-09-15T12:00:00.000Z'
    })
  })
})

function executionOption(view: { items: unknown[] }, itemId: string, action: string) {
  const item = view.items.find((candidate) => (candidate as { itemId?: string }).itemId === itemId) as { actions?: unknown[] } | undefined
  const availability = item?.actions?.find((candidate) => (candidate as { action?: string }).action === action) as { execution?: { options?: unknown[] } } | undefined
  const option = availability?.execution?.options?.[0] as { optionId?: string; expiresAt?: string; acknowledgement?: { acknowledgementId?: string } } | undefined
  if (!option?.optionId || !option.expiresAt) throw new Error(`Missing ${action} option for ${itemId}`)
  return { optionId: option.optionId, expiresAt: option.expiresAt, acknowledgementId: option.acknowledgement?.acknowledgementId }
}

function fixedDeps(now = new Date('2026-09-15T12:00:00.000Z')) {
  return { now: () => now, uuid: () => 'fixed-id', random: () => 0.5 }
}

function sequenceDeps(randoms: number[], uuids: string[]) {
  let randomIndex = 0
  let uuidIndex = 0
  return {
    now: () => new Date('2026-09-15T12:00:00.000Z'),
    random: () => randoms[randomIndex++] ?? randoms.at(-1) ?? 0,
    uuid: () => uuids[uuidIndex++] ?? uuids.at(-1) ?? 'id'
  }
}
