import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SaveGame } from '../types/game'
import { createSaveGame } from '../utils/game-logic'
import type { PersistedGameV3 } from '../server/utils/savegame'
import { generateLootForZone, LOOT_CONFIG_VERSION, validateLootConfig } from '../server/domain/loot-v2'

let document: PersistedGameV3 | Record<string, unknown> | undefined
let uncertainCommit = false
let forceCasMiss = false
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
    if (forceCasMiss) return { modifiedCount: 0 }
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
    forceCasMiss = false
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

  it('maps exhausted deterministic CAS misses to a revision conflict', async () => {
    const { mutateSaveGameAtomic, RevisionConflictError } = await import('../server/utils/savegame')
    forceCasMiss = true

    await expect(mutateSaveGameAtomic(
      'atomic-user', 'cas-exhausted', 'credit:cas-exhausted', 0, { amount: 1 },
      (save) => { save.gold += 1 }
    )).rejects.toBeInstanceOf(RevisionConflictError)
    expect(collection.replaceOne).toHaveBeenCalledTimes(5)
  })

  it('keeps business keys permanent across request IDs', async () => {
    const { BusinessKeyConflictError, mutateSaveGameAtomic } = await import('../server/utils/savegame')
    await mutateSaveGameAtomic('atomic-user', 'business-a', 'transfer:item-1', 0, {}, () => {})
    await expect(mutateSaveGameAtomic('atomic-user', 'business-b', 'transfer:item-1', 1, {}, () => {}))
      .rejects.toBeInstanceOf(BusinessKeyConflictError)
  })

  it('replays an exact V2 command envelope and rejects another request for its consumed business key', async () => {
    const { BusinessKeyConflictError, isPersistedCanonical, mutateSaveGameAtomic, mutateVisitorCycleAtomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const persisted = document as PersistedGameV3
    const visitorId = Object.keys(persisted.visitorCycle.visitors)[0]!
    const optionId = persisted.visitorCycle.visitors[visitorId]!.contractOptions[0]!.optionId
    let id = 0
    const dependencies = {
      now: () => new Date(persisted.createdAt), random: () => 0.9,
      uuid: () => `atomic-v2-${++id}`
    }
    const command = { action: 'accept_contract' as const, visitorId, optionId, loanItemIds: [persisted.stash[0]!] }
    const first = await mutateVisitorCycleAtomic(
      'atomic-user', 'v2-request', 0, command, `v2:contract:${visitorId}:${optionId}`, mapPersistedGameToGameView, dependencies
    )
    await mutateSaveGameAtomic('atomic-user', 'later-v2-command', 'later:v2-credit', 1, { amount: 1 }, (save) => { save.gold += 1 })
    const replay = await mutateVisitorCycleAtomic(
      'atomic-user', 'v2-request', 999, command, `v2:contract:${visitorId}:${optionId}`, mapPersistedGameToGameView, dependencies
    )

    expect(replay).toEqual(first)
    expect(first).toMatchObject({ requestId: 'v2-request', revision: 1, game: { revision: 1 } })
    expect((document as PersistedGameV3).ledger).toHaveLength(2)
    await expect(mutateVisitorCycleAtomic(
      'atomic-user', 'v2-other-request', 2, command, `v2:contract:${visitorId}:${optionId}`, mapPersistedGameToGameView, dependencies
    )).rejects.toBeInstanceOf(BusinessKeyConflictError)

    const stored = (document as PersistedGameV3).requestRecords.find((record) => record.requestId === 'v2-request')!
    if (!('game' in stored.response)) throw new Error('Expected stored V2 response')
    ;(stored.response.game as unknown as Record<string, unknown>).internalSecret = true
    expect(isPersistedCanonical(document)).toBe(false)
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

  it('does not let compatibility reads advance a legacy commission', async () => {
    const { getPersistedGameV3, getSaveGame, mutateSaveGameAtomic } = await import('../server/utils/savegame')
    const { assignVisitorCommission } = await import('../utils/visitor-logic')
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
    await getSaveGame('atomic-user', reconcileDependencies)
    const unchanged = await getPersistedGameV3('atomic-user')
    const unchangedVisitor = unchanged.visitRound.slots.find((slot) => slot.visitor?.id === visitorId)!.visitor!
    expect(unchanged.revision).toBe(assigned.revision)
    expect(unchangedVisitor.state).toBe('commissioned')
    expect(unchangedVisitor.commission).toMatchObject({ status: 'active', finishesAt: finish })
    expect(unchangedVisitor.commission?.rewardItemId).toBeUndefined()
  })

  it.each(['queue_blacksmith_job', 'queue_enchanter_job', 'dismantle_item', 'sell', 'loan'] as const)('keeps claimed configured reward placement after %s and a legacy round-trip', async (action) => {
    const { mutateEquipmentV2Atomic, mutateSaveGameAtomic, transitionItemAtomic, isPersistedCanonical } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const claimed = await claimConfiguredReward()
    const rewardItemId = claimed.rewardItemId
    document = claimed.persisted

    if (action === 'queue_blacksmith_job' || action === 'queue_enchanter_job') {
      const option = executionOption(mapPersistedGameToGameView(claimed.persisted, fixedDeps().now()), rewardItemId, action)
      await mutateEquipmentV2Atomic('atomic-user', `reward-${action}`, claimed.persisted.revision, {
        action, itemId: rewardItemId, optionId: option.optionId
      }, fixedDeps())
    } else if (action === 'dismantle_item') {
      const option = executionOption(mapPersistedGameToGameView(claimed.persisted, fixedDeps().now()), rewardItemId, action)
      await mutateEquipmentV2Atomic('atomic-user', `reward-${action}`, claimed.persisted.revision, {
        action, itemId: rewardItemId, optionId: option.optionId, acknowledgementId: option.acknowledgementId
      }, fixedDeps())
    } else if (action === 'sell') {
      await transitionItemAtomic('atomic-user', 'reward-sell', claimed.persisted.revision, {
        operation: 'sell', itemId: rewardItemId, targetId: claimed.visitorId
      })
    } else {
      await transitionItemAtomic('atomic-user', 'reward-loan', claimed.persisted.revision, {
        operation: 'loan', itemId: rewardItemId, targetId: claimed.commissionId
      })
    }

    const afterAction = document as PersistedGameV3
    const expectedPlacement = structuredClone(afterAction.itemPlacements[rewardItemId])
    expect(isPersistedCanonical(document)).toBe(true)

    await mutateSaveGameAtomic('atomic-user', `reward-${action}-legacy-round-trip`, `reward:${action}:legacy-round-trip`, afterAction.revision, {}, () => {}, fixedDeps())

    const afterRoundTrip = document as PersistedGameV3
    expect(afterRoundTrip.itemPlacements[rewardItemId]).toEqual(expectedPlacement)
    if (action === 'dismantle_item') {
      expect(afterRoundTrip.itemPlacements[rewardItemId]).toEqual({
        ownerKind: 'tombstone', custodyKind: 'tombstone', custodyId: `dismantle-${rewardItemId}`
      })
      expect(afterRoundTrip.stash).not.toContain(rewardItemId)
    }
    expect(isPersistedCanonical(document)).toBe(true)
  })

  it('reconciles sequential enchanter jobs for a claimed configured reward and reloads them canonically', async () => {
    const { getEnchanterOption } = await import('../server/domain/equipment-v2')
    const { getPersistedGameV3, isPersistedCanonical, mutateEquipmentV2Atomic, reconcilePersistedGameV3, transitionItemAtomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const claimed = await claimConfiguredReward()
    const { rewardItemId } = claimed
    const sealedAffixes = structuredClone(claimed.persisted.itemV2ById[rewardItemId]!.sealedAffixes!)
    const provenance = structuredClone(claimed.persisted.itemV2ById[rewardItemId]!.provenance!)
    const queuedAt = new Date('2026-09-15T12:00:00.000Z')
    const firstDependencies = { ...fixedDeps(queuedAt), uuid: () => 'reward-enchanter-one' }
    document = claimed.persisted

    const option = executionOption(mapPersistedGameToGameView(claimed.persisted, queuedAt), rewardItemId, 'queue_enchanter_job')
    const queued = await mutateEquipmentV2Atomic('atomic-user', 'reward-enchanter-queue', claimed.persisted.revision, {
      action: 'queue_enchanter_job', itemId: rewardItemId, optionId: option.optionId
    }, firstDependencies)
    const firstJobId = Object.keys(queued.serviceJobStateById).find((id) => id.startsWith('enchanter-'))!
    const completedOnce = await reconcilePersistedGameV3('atomic-user', fixedDeps(new Date('2026-09-15T12:02:00.000Z')))
    const secondQueuedAt = new Date('2026-09-15T12:03:00.000Z')
    const secondOption = executionOption(mapPersistedGameToGameView(completedOnce, secondQueuedAt), rewardItemId, 'queue_enchanter_job')
    const queuedAgain = await mutateEquipmentV2Atomic('atomic-user', 'reward-enchanter-queue-again', completedOnce.revision, {
      action: 'queue_enchanter_job', itemId: rewardItemId, optionId: secondOption.optionId
    }, { ...fixedDeps(secondQueuedAt), uuid: () => 'reward-enchanter-two' })
    const secondJobId = Object.keys(queuedAgain.serviceJobStateById).find((id) => id !== firstJobId)!
    expect(queuedAgain.serviceJobStateById[firstJobId]?.status).toBe('completed')

    const completed = await reconcilePersistedGameV3('atomic-user', fixedDeps(new Date('2026-09-15T12:05:00.000Z')))
    const reloaded = await getPersistedGameV3('atomic-user')
    const enchantedAffixes = [firstJobId, secondJobId].map((jobId) => completed.serviceJobStateById[jobId]!.result.affix!)

    expect(reloaded.itemPlacements[rewardItemId]).toEqual({ ownerKind: 'caravan', custodyKind: 'stash' })
    expect(reloaded.serviceJobStateById[firstJobId]).toMatchObject({ status: 'completed', itemId: rewardItemId })
    expect(reloaded.serviceJobStateById[secondJobId]).toMatchObject({ status: 'completed', itemId: rewardItemId })
    expect(reloaded.itemV2ById[rewardItemId]).toMatchObject({
      sealedAffixes,
      provenance,
      enchantCount: 2
    })
    expect(reloaded.itemsById[rewardItemId]!.affixes).toEqual([...sealedAffixes, ...enchantedAffixes])
    expect(isPersistedCanonical(reloaded)).toBe(true)

    const retried = await mutateEquipmentV2Atomic('atomic-user', 'reward-enchanter-complete-retry', reloaded.revision, {
      action: 'complete_service_job', jobId: secondJobId
    }, fixedDeps(new Date('2026-09-15T12:06:00.000Z')))
    expect(retried.revision).toBe(reloaded.revision)
    expect(retried.itemsById[rewardItemId]!.affixes).toEqual([...sealedAffixes, ...enchantedAffixes])

    const fabricatedAffix = structuredClone(reloaded)
    fabricatedAffix.itemsById[rewardItemId]!.affixes.push({ stat: 'life', value: 999 })
    expect(isPersistedCanonical(fabricatedAffix)).toBe(false)

    const fabricatedResult = structuredClone(reloaded)
    fabricatedResult.serviceJobStateById[secondJobId]!.result.affix = { stat: 'life', value: 999 }
    fabricatedResult.itemsById[rewardItemId]!.affixes.at(-1)!.stat = 'life'
    fabricatedResult.itemsById[rewardItemId]!.affixes.at(-1)!.value = 999
    expect(isPersistedCanonical(fabricatedResult)).toBe(false)

    const fabricatedCancelled = structuredClone(reloaded)
    const fabricatedJobId = 'enchanter-fabricated-cancelled'
    fabricatedCancelled.serviceJobsById[fabricatedJobId] = {
      id: fabricatedJobId,
      itemIds: [],
      projection: {
        kind: 'service', service: 'enchanter',
        queuedAt: '2026-09-15T12:07:00.000Z', startsAt: '2026-09-15T12:07:00.000Z'
      }
    }
    fabricatedCancelled.serviceJobStateById[fabricatedJobId] = {
      status: 'cancelled', service: 'enchanter', itemId: rewardItemId,
      queuedAt: '2026-09-15T12:07:00.000Z', startedAt: '2026-09-15T12:07:00.000Z',
      completesAt: '2026-09-15T12:08:00.000Z', cancelledAt: '2026-09-15T12:07:30.000Z',
      result: {
        enchantCount: 999,
        affix: getEnchanterOption(reloaded.itemsById[rewardItemId]!, { enchantCount: 998 }).affix
      }
    }
    expect(isPersistedCanonical(fabricatedCancelled)).toBe(false)

    await transitionItemAtomic('atomic-user', 'reward-enchanter-loan', reloaded.revision, {
      operation: 'loan', itemId: rewardItemId, targetId: claimed.commissionId
    })
    const loaned = await getPersistedGameV3('atomic-user')
    expect(loaned.itemPlacements[rewardItemId]).toEqual({
      ownerKind: 'caravan', custodyKind: 'expedition', custodyId: claimed.commissionId
    })
    expect(isPersistedCanonical(loaned)).toBe(true)
  })

  it('keeps claimed configured reward sold through the real legacy visitor sale out of stash', async () => {
    const { mutateSaveGameAtomic, isPersistedCanonical } = await import('../server/utils/savegame')
    const { sellToVisitor } = await import('../utils/visitor-logic')
    const claimed = await claimConfiguredReward()
    const rewardItemId = claimed.rewardItemId
    const reward = claimed.persisted.itemsById[rewardItemId]!
    document = claimed.persisted

    await mutateSaveGameAtomic('atomic-user', 'reward-real-legacy-sell', 'reward:real-legacy-sell', claimed.persisted.revision, {}, (save) => {
      const stashReward = save.stash.find((item) => item.id === rewardItemId)
      if (!stashReward) throw new Error('Expected claimed reward in public stash')
      stashReward.identified = true
      const buyer = {
        id: 'reward-buyer',
        name: 'Reward Buyer',
        class: 'paladin' as const,
        level: 5,
        origin: 'Test Market',
        equipmentSummary: [],
        state: 'open' as const,
        budget: 500,
        initialBudget: 500,
        acceptedItemTypes: [reward.type],
        interestedItemTypes: [reward.type],
        offers: [],
        buyQuotes: { [rewardItemId]: 123 },
        trades: [],
        power: 50,
        commissionOptions: [],
        arrivedAt: save.updatedAt
      }
      save.visitRound.slots[0] = { id: save.visitRound.slots[0]?.id ?? 'visitor-slot-1', visitor: buyer }
      sellToVisitor(save, buyer.id, rewardItemId, 'sell-claimed-reward', fixedDeps().now())
    }, fixedDeps())

    const afterSale = document as PersistedGameV3
    expect(afterSale.itemPlacements[rewardItemId]).toEqual({
      ownerKind: 'visitor', ownerId: 'reward-buyer', custodyKind: 'visitor', custodyId: 'reward-buyer'
    })
    expect(afterSale.stash).not.toContain(rewardItemId)
    expect(isPersistedCanonical(document)).toBe(true)
  })

  it('supports boss reward claim identify and imprint replacement from the configured reward', async () => {
    const { mutateEquipmentV2Atomic, isPersistedCanonical } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const claimed = await claimConfiguredReward('act-boss', [0.5, 0.1, 0.2, 0.3])
    const rewardItemId = claimed.rewardItemId
    document = claimed.persisted

    const identify = executionOption(mapPersistedGameToGameView(claimed.persisted, fixedDeps().now()), rewardItemId, 'identify_item')
    const identified = await mutateEquipmentV2Atomic('atomic-user', 'boss-reward-identify', claimed.persisted.revision, {
      action: 'identify_item', itemId: rewardItemId, optionId: identify.optionId
    }, fixedDeps())
    const imprint = executionOption(mapPersistedGameToGameView(identified, fixedDeps().now()), rewardItemId, 'replace_boss_imprint')
    const replaced = await mutateEquipmentV2Atomic('atomic-user', 'boss-reward-imprint', identified.revision, {
      action: 'replace_boss_imprint', itemId: rewardItemId, optionId: imprint.optionId, acknowledgementId: imprint.acknowledgementId
    }, fixedDeps())

    expect(replaced.itemV2ById[rewardItemId]!.activeImprint?.imprintId).toBe('boss-act-boss')
    expect(replaced.itemV2ById[rewardItemId]!.pendingImprint).toBeUndefined()
    expect(isPersistedCanonical(replaced)).toBe(true)
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

  it('surfaces a retryable uncertain result when a write error cannot be reconciled', async () => {
    const { mutateSaveGameAtomic } = await import('../server/utils/savegame')
    const { UncertainOperationError } = await import('../server/domain/v2-errors')
    collection.replaceOne.mockRejectedValueOnce(new Error('network timeout with unknown commit state'))

    await expect(mutateSaveGameAtomic(
      'atomic-user', 'uncertain-unconfirmed', 'credit:unknown', 0, { amount: 3 },
      (save) => { save.gold += 3 }
    )).rejects.toMatchObject({
      name: 'UncertainOperationError',
      requestId: 'uncertain-unconfirmed'
    })
  })

  it('preserves uncertain request identity when both mutation write and verification read fail', async () => {
    const { mutateSaveGameAtomic } = await import('../server/utils/savegame')
    collection.findOne
      .mockResolvedValueOnce(structuredClone(document!))
      .mockRejectedValueOnce(new Error('verification read failed'))
    collection.replaceOne.mockRejectedValueOnce(new Error('write result unknown'))

    await expect(mutateSaveGameAtomic(
      'atomic-user', 'double-failure-mutation', 'credit:double-failure', 0, { amount: 3 },
      (save) => { save.gold += 3 }
    )).rejects.toMatchObject({
      name: 'UncertainOperationError',
      requestId: 'double-failure-mutation'
    })
  })

  it('preserves uncertain request identity when item write and verification read both fail', async () => {
    const { transitionItemAtomic } = await import('../server/utils/savegame')
    const persisted = structuredClone(document) as PersistedGameV3
    const itemId = persisted.stash[0]!
    const visitorId = persisted.visitRound.slots.find((slot) => slot.visitor)?.visitor?.id!
    collection.findOne
      .mockResolvedValueOnce(persisted)
      .mockRejectedValueOnce(new Error('verification read failed'))
    collection.replaceOne.mockRejectedValueOnce(new Error('write result unknown'))

    await expect(transitionItemAtomic(
      'atomic-user', 'double-failure-item', 0, { operation: 'sell', itemId, targetId: visitorId }
    )).rejects.toMatchObject({
      name: 'UncertainOperationError',
      requestId: 'double-failure-item'
    })
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

  it('caps shared replay records across legacy, item transition, equipment, and visitor-cycle writers', async () => {
    const { mutateEquipmentV2Atomic, mutateSaveGameAtomic, mutateVisitorCycleAtomic, sanitizeGameResponse, transitionItemAtomic } = await import('../server/utils/savegame')
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

    const afterEquipment = document as PersistedGameV3
    const contractVisitorId = Object.keys(afterEquipment.visitorCycle.visitors)[0]!
    const contractOptionId = afterEquipment.visitorCycle.visitors[contractVisitorId]!.contractOptions[0]!.optionId
    await mutateVisitorCycleAtomic('atomic-user', 'visitor-fresh', 123, {
      action: 'accept_contract', visitorId: contractVisitorId, optionId: contractOptionId, loanItemIds: []
    }, `v2:contract:${contractVisitorId}:${contractOptionId}`, mapPersistedGameToGameView, deps)

    const final = document as PersistedGameV3
    expect(final.requestRecords).toHaveLength(100)
    expect(final.ledger).toHaveLength(124)
    expect(Object.keys(final.businessKeys)).toHaveLength(124)
    expect(final.requestRecords.map((entry) => entry.requestId)).toEqual(expect.arrayContaining(['legacy-fresh', 'transition-fresh', 'equipment-fresh', 'visitor-fresh']))
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

  it('backfills historical claimed commission rewards without moving or recreating them', async () => {
    const { getPersistedGameV3, hydratePersistedGame, isPersistedCanonical } = await import('../server/utils/savegame')
    const legacyV3 = historicalClaimedRewardFixture()
    const movedRewardId = 'historical-moved-reward'
    const soldRewardId = 'historical-sold-reward'
    const before = structuredClone(legacyV3)
    document = legacyV3 as unknown as PersistedGameV3

    const backfilled = await getPersistedGameV3('atomic-user')
    const replay = await getPersistedGameV3('atomic-user')

    expect(backfilled).toEqual(replay)
    expect(isPersistedCanonical(backfilled)).toBe(true)
    expect(collection.replaceOne).toHaveBeenCalledTimes(1)
    expect(backfilled.revision).toBe(before.revision)
    expect(backfilled.gold).toBe(before.gold)
    expect(backfilled.materials).toEqual(before.materials)
    expect(backfilled.itemsById).toEqual(before.itemsById)
    expect(backfilled.visitRound).toEqual(before.visitRound)
    expect(backfilled.visitHistory).toEqual(before.visitHistory)
    expect(backfilled.ledger).toEqual(before.ledger)
    expect(backfilled.requestRecords).toEqual(before.requestRecords)
    expect(backfilled.businessKeys).toEqual(before.businessKeys)
    expect(backfilled.itemPlacements[movedRewardId]).toEqual(before.itemPlacements[movedRewardId])
    expect(backfilled.itemPlacements[soldRewardId]).toEqual(before.itemPlacements[soldRewardId])
    expect(backfilled.stash).not.toContain(movedRewardId)
    expect(backfilled.stash).not.toContain(soldRewardId)
    expect(backfilled.itemV2ById[movedRewardId]?.provenance).toMatchObject({
      zoneId: 'blood-moor',
      lootTableId: 'act1-low',
      configVersion: LOOT_CONFIG_VERSION,
      businessKey: 'loot:historical-moved-commission:reward'
    })
    expect(backfilled.itemV2ById[soldRewardId]?.provenance).toMatchObject({
      zoneId: 'blood-moor',
      lootTableId: 'act1-low',
      configVersion: LOOT_CONFIG_VERSION,
      businessKey: 'loot:historical-sold-commission:reward'
    })
    expect(hydratePersistedGame(backfilled).stash.map((item) => item.id)).not.toContain(soldRewardId)
  })

  it('rejects contradictory historical claimed rewards after backfill', async () => {
    const { getPersistedGameV3, PersistedGameCorruptError } = await import('../server/utils/savegame')
    const legacyV3 = historicalClaimedRewardFixture()
    const firstCommission = legacyV3.visitRound.slots[0]!.visitor!.commission!
    const secondCommission = legacyV3.visitRound.slots[1]!.visitor!.commission!
    secondCommission.rewardItemId = firstCommission.rewardItemId
    document = legacyV3 as unknown as PersistedGameV3

    await expect(getPersistedGameV3('atomic-user')).rejects.toBeInstanceOf(PersistedGameCorruptError)
  })

  it('does not repair a partially declared item V2 map as historical absence', async () => {
    const { getPersistedGameV3, PersistedGameCorruptError } = await import('../server/utils/savegame')
    const partial = historicalClaimedRewardFixture() as PersistedGameV3
    partial.itemV2ById = {}
    document = partial

    await expect(getPersistedGameV3('atomic-user')).rejects.toBeInstanceOf(PersistedGameCorruptError)
  })

  it.each([
    ['malformed service map', (partial: Record<string, unknown>) => {
      delete partial.itemV2ById
      partial.serviceJobStateById = { broken: 'invalid' }
    }],
    ['malformed item map', (partial: Record<string, unknown>) => {
      partial.itemV2ById = { broken: 'invalid' }
      delete partial.serviceJobStateById
    }]
  ])('rejects historical absence paired with a %s', async (_label, corrupt) => {
    const { getPersistedGameV3, PersistedGameCorruptError } = await import('../server/utils/savegame')
    const partial = structuredClone(document as PersistedGameV3) as unknown as Record<string, unknown>
    corrupt(partial)
    document = partial as unknown as PersistedGameV3

    await expect(getPersistedGameV3('atomic-user')).rejects.toBeInstanceOf(PersistedGameCorruptError)
  })

  it.each([
    ['missing materials', (partial: Record<string, unknown>) => {
      delete partial.materials
    }],
    ['malformed gold', (partial: Record<string, unknown>) => {
      partial.gold = -1
    }],
    ['malformed timestamps', (partial: Record<string, unknown>) => {
      partial.updatedAt = 'not-a-date'
    }]
  ])('rejects historical V2 map absence paired with %s without writing', async (_label, corrupt) => {
    const { getPersistedGameV3, PersistedGameCorruptError } = await import('../server/utils/savegame')
    const partial = historicalClaimedRewardFixture() as unknown as Record<string, unknown>
    corrupt(partial)
    document = partial as unknown as PersistedGameV3

    await expect(getPersistedGameV3('atomic-user')).rejects.toBeInstanceOf(PersistedGameCorruptError)
    expect(collection.replaceOne).not.toHaveBeenCalled()
  })

  it.each([
    ['loot table', (state: PersistedGameV3['itemV2ById'][string]) => {
      state.provenance!.lootTableId = 'act1-mid'
    }],
    ['drop timestamp', (state: PersistedGameV3['itemV2ById'][string]) => {
      state.provenance!.droppedAt = '2026-09-15T12:34:56.000Z'
    }],
    ['sealed affixes', (state: PersistedGameV3['itemV2ById'][string]) => {
      state.sealedAffixes = [{ stat: 'attackPower', value: 999 }]
    }]
  ])('rejects historical reward metadata with contradictory %s', async (_label, corrupt) => {
    const { getPersistedGameV3, PersistedGameCorruptError } = await import('../server/utils/savegame')
    document = historicalClaimedRewardFixture() as unknown as PersistedGameV3
    const backfilled = await getPersistedGameV3('atomic-user')
    const rewardItemId = backfilled.visitRound.slots[0]!.visitor!.commission!.rewardItemId!
    corrupt(backfilled.itemV2ById[rewardItemId]!)
    document = backfilled
    vi.clearAllMocks()

    await expect(getPersistedGameV3('atomic-user')).rejects.toBeInstanceOf(PersistedGameCorruptError)
    expect(collection.replaceOne).not.toHaveBeenCalled()
  })

  it('accepts semantically equal sealed affixes regardless of BSON property order', async () => {
    const { getPersistedGameV3, isPersistedCanonical } = await import('../server/utils/savegame')
    document = historicalClaimedRewardFixture() as unknown as PersistedGameV3
    const backfilled = await getPersistedGameV3('atomic-user')
    const rewardItemId = backfilled.visitRound.slots[0]!.visitor!.commission!.rewardItemId!
    const item = backfilled.itemsById[rewardItemId]!
    backfilled.itemV2ById[rewardItemId]!.sealedAffixes = item.affixes.map(({ stat, value }) => ({ value, stat }))
    document = backfilled
    vi.clearAllMocks()

    await expect(getPersistedGameV3('atomic-user')).resolves.toEqual(backfilled)
    expect(isPersistedCanonical(backfilled)).toBe(true)
    expect(collection.replaceOne).not.toHaveBeenCalled()
  })

  it('accepts a completed historical commission without a reward item id', async () => {
    const { getPersistedGameV3, isPersistedCanonical } = await import('../server/utils/savegame')
    const legacyV3 = historicalClaimedRewardFixture()
    const commission = legacyV3.visitRound.slots[0]!.visitor!.commission!
    const rewardItemId = commission.rewardItemId!
    delete commission.rewardItemId
    legacyV3.expeditionsById[commission.id]!.itemIds = []
    delete legacyV3.itemsById[rewardItemId]
    delete legacyV3.itemPlacements[rewardItemId]
    document = legacyV3 as unknown as PersistedGameV3

    const backfilled = await getPersistedGameV3('atomic-user')

    expect(isPersistedCanonical(backfilled)).toBe(true)
    expect(backfilled.itemV2ById[rewardItemId]).toBeUndefined()
    expect(collection.replaceOne).toHaveBeenCalledOnce()
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
  it('rejects invalid zones tables and unique entries instead of falling back', () => {
    expect(() => generateLootForZone({
      zoneId: 'missing-zone',
      businessKey: 'loot:missing-zone',
      droppedAt: '2026-09-15T12:00:00.000Z'
    }, sequenceDeps([0], ['missing']))).toThrow('Unknown loot zone')

    expect(() => validateLootConfig({
      'act1-low': { tableId: 'foreign-table', entries: [{ weight: 1, baseIndex: 0, rarity: 'normal' }] }
    })).toThrow('Unknown loot table')

    expect(() => validateLootConfig({
      'act1-low': { tableId: 'act1-low', entries: [{ weight: 1, baseIndex: 999, rarity: 'normal' }] },
      'act1-mid': { tableId: 'act1-mid', entries: [{ weight: 1, baseIndex: 0, rarity: 'normal' }] },
      'act1-high': { tableId: 'act1-high', entries: [{ weight: 1, baseIndex: 0, rarity: 'normal' }] },
      'act1-boss': { tableId: 'act1-boss', entries: [{ weight: 1, baseIndex: 0, rarity: 'normal' }] }
    })).toThrow('Unknown loot base index')

    expect(() => validateLootConfig({
      'act1-low': { tableId: 'act1-low', entries: [{ weight: 1, baseIndex: 0, rarity: 'normal' }] },
      'act1-mid': { tableId: 'act1-mid', entries: [{ weight: 1, baseIndex: 0, rarity: 'normal' }] },
      'act1-high': { tableId: 'act1-high', entries: [{ weight: 1, baseIndex: 0, rarity: 'normal' }] },
      'act1-boss': { tableId: 'act1-boss', entries: [{ weight: 1, baseIndex: 19, rarity: 'unique' }] }
    })).toThrow('No compatible unique')
  })

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

function historicalClaimedRewardFixture(): Omit<PersistedGameV3, 'itemV2ById' | 'serviceJobStateById'> {
  const persisted = structuredClone(document as PersistedGameV3)
  persisted.revision = 166
  const [firstSlot, secondSlot] = persisted.visitRound.slots
  const first = firstSlot?.visitor
  const second = secondSlot?.visitor
  if (!first || !second) throw new Error('Expected two visitors')
  const [movedRewardId, soldRewardId] = ['historical-moved-reward', 'historical-sold-reward']
  const template = persisted.itemsById[persisted.stash[0]!]!
  persisted.itemsById[movedRewardId] = { ...structuredClone(template), id: movedRewardId }
  persisted.itemsById[soldRewardId] = { ...structuredClone(template), id: soldRewardId }
  persisted.stash = persisted.stash.filter((itemId) => itemId !== movedRewardId && itemId !== soldRewardId)
  attachHistoricalClaimedCommission(persisted, first, movedRewardId, 'historical-moved-commission')
  attachHistoricalClaimedCommission(persisted, second, soldRewardId, 'historical-sold-commission')
  persisted.expeditionsById['historical-moved-commission']!.itemIds = [movedRewardId]
  persisted.itemPlacements[movedRewardId] = {
    ownerKind: 'caravan', custodyKind: 'expedition', custodyId: 'historical-moved-commission'
  }
  second.trades.push({
    requestId: 'historical-sold-reward-sale',
    kind: 'player_sold',
    itemId: soldRewardId,
    price: 123,
    createdAt: persisted.updatedAt
  })
  persisted.itemPlacements[soldRewardId] = {
    ownerKind: 'visitor', ownerId: second.id, custodyKind: 'visitor', custodyId: second.id
  }
  delete (persisted as Partial<PersistedGameV3>).itemV2ById
  delete (persisted as Partial<PersistedGameV3>).serviceJobStateById
  return persisted
}

function attachHistoricalClaimedCommission(
  persisted: PersistedGameV3,
  visitor: PersistedGameV3['visitRound']['slots'][number]['visitor'],
  rewardItemId: string,
  commissionId: string
): void {
  if (!visitor) throw new Error('Expected visitor')
  visitor.state = 'departed'
  visitor.departedAt = persisted.updatedAt
  visitor.commission = {
    ...visitor.commissionOptions[0]!,
    id: commissionId,
    status: 'claimed',
    startedAt: persisted.createdAt,
    finishesAt: persisted.updatedAt,
    outcomeRoll: 0,
    outcome: 'complete',
    rewardGold: visitor.commissionOptions[0]!.fullRewardGold,
    rewardItemId,
    claimedAt: persisted.updatedAt
  }
  persisted.expeditionsById[commissionId] = {
    id: commissionId,
    itemIds: [],
    projection: { kind: 'expedition', visitorId: visitor.id, contractId: commissionId, startsAt: persisted.createdAt }
  }
  persisted.settlementsById[commissionId] = {
    id: commissionId,
    itemIds: [],
    projection: { kind: 'settlement', expeditionId: commissionId, outcome: 'returned', appliedAt: persisted.updatedAt }
  }
}

async function claimConfiguredReward(
  regionId = 'blood-moor',
  randoms: number[] = [0, 0.25, 0.5, 0.75]
): Promise<{ persisted: PersistedGameV3; rewardItemId: string; visitorId: string; commissionId: string }> {
  const { getPersistedGameV3, mutateSaveGameAtomic } = await import('../server/utils/savegame')
  const { assignVisitorCommission, claimVisitorCommission, refreshVisitRound } = await import('../utils/visitor-logic')
  const initial = await getPersistedGameV3('atomic-user')
  const visitorId = initial.visitRound.slots.find((slot) => slot.visitor)?.visitor?.id!
  const start = new Date('2026-09-13T00:00:00.000Z')
  const dependencies = sequenceDeps(randoms, [`reward-${regionId}`])

  await mutateSaveGameAtomic('atomic-user', `assign-${regionId}`, `commission:assign:${regionId}`, initial.revision, {}, (save) => {
    const visitor = save.visitRound.slots.find((slot) => slot.visitor?.id === visitorId)!.visitor!
    visitor.state = 'traded'
    visitor.commissionOptions[0] = { ...visitor.commissionOptions[0]!, regionId }
    assignVisitorCommission(save, visitorId, 'safe', () => 0, start)
  }, { ...dependencies, now: () => start })
  const assigned = await getPersistedGameV3('atomic-user')
  const commission = assigned.visitRound.slots.find((slot) => slot.visitor?.id === visitorId)!.visitor!.commission!
  await mutateSaveGameAtomic(
    'atomic-user', `reconcile-${regionId}`, `commission:reconcile:${regionId}`, assigned.revision, {},
    (save, deps) => refreshVisitRound(save, deps.now(), deps.random),
    { ...dependencies, now: () => new Date(commission.finishesAt) }
  )
  const ready = await getPersistedGameV3('atomic-user')
  await mutateSaveGameAtomic('atomic-user', `claim-${regionId}`, `commission:claim:${regionId}`, ready.revision, {}, (save) => {
    claimVisitorCommission(save, visitorId, new Date(commission.finishesAt))
  }, { ...dependencies, now: () => new Date(commission.finishesAt) })
  const persisted = await getPersistedGameV3('atomic-user')
  const claimedCommission = [persisted.visitRound, ...persisted.visitHistory]
    .flatMap((round) => round.slots)
    .find((slot) => slot.visitor?.id === visitorId)!.visitor!.commission!
  return { persisted, rewardItemId: claimedCommission.rewardItemId!, visitorId, commissionId: claimedCommission.id }
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
