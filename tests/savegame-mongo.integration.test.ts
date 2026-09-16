import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoClient, type Collection } from 'mongodb'
import type { SaveGame } from '../types/game'
import type { PersistedGameV3 } from '../server/utils/savegame'

const mongoUri = process.env.MONGO_TEST_URI
const suite = mongoUri ? describe : describe.skip
let client: MongoClient
let collection: Collection
let repositoryCollection: Collection
const prefix = `alta43-${process.pid}`
const userIds = [`${prefix}-replay`, `${prefix}-reset`, `${prefix}-business`, `${prefix}-sell-loan`, `${prefix}-sell-dismantle`, `${prefix}-service-loan`, `${prefix}-transition-replay`, `${prefix}-custody`, `${prefix}-materials`, `${prefix}-uncertain`, `${prefix}-corrupt`, `${prefix}-commission-flow`, `${prefix}-service-roundtrip`, `${prefix}-retained-return`, `${prefix}-retained-missing-source`, `${prefix}-retained-malformed-source`, `${prefix}-retained-backfill-race`, `${prefix}-equipment-replay`, `${prefix}-equipment-uncertain`, `${prefix}-equipment-cas`, `${prefix}-equipment-job-tombstone`, `${prefix}-reward-replay`, `${prefix}-reward-cas`, `${prefix}-historical-reward-backfill`]

vi.mock('../server/utils/db', () => ({ saveGamesCollection: async () => repositoryCollection }))

suite('PersistedGameV3 against isolated real MongoDB', () => {
  beforeAll(async () => {
    client = new MongoClient(mongoUri!)
    await client.connect()
    collection = client.db('diablo_tavern_alta43_integration').collection('savegames')
    repositoryCollection = collection
    await collection.createIndex({ userId: 1 }, { unique: true, name: 'userId_unique' })
    await collection.deleteMany({ userId: { $in: userIds } })
  })

  afterAll(async () => {
    if (!client) return
    await collection.deleteMany({ userId: { $in: userIds } })
    await client.close()
  })

  it('commits concurrent retries once and reloads the exact public response', async () => {
    const { getSaveGame, mutateSaveGameAtomic } = await import('../server/utils/savegame')
    await getSaveGame(userIds[0]!)
    const command = { amount: 37 }
    const mutate = (save: SaveGame) => { save.gold += 37 }
    const [first, retry] = await Promise.all([
      mutateSaveGameAtomic(userIds[0]!, 'mongo-request-1', 'mongo-credit:one', 0, command, mutate),
      mutateSaveGameAtomic(userIds[0]!, 'mongo-request-1', 'mongo-credit:one', 0, command, mutate)
    ])
    const reloaded = await getSaveGame(userIds[0]!)
    const persisted = await collection.findOne({ userId: userIds[0] })
    expect(first).toEqual(retry)
    expect(reloaded).toEqual(first)
    expect(first.gold).toBe(487)
    expect(persisted?.requestRecords).toHaveLength(1)
    expect(persisted?.ledger).toHaveLength(1)
  })

  it('rejects stale CAS and a second requestId for one permanent business key', async () => {
    const { BusinessKeyConflictError, mutateSaveGameAtomic, RevisionConflictError } = await import('../server/utils/savegame')
    await mutateSaveGameAtomic(userIds[2]!, 'business-a', 'business:one', 0, {}, () => {})
    await expect(mutateSaveGameAtomic(userIds[2]!, 'stale', 'business:other', 0, {}, () => {}))
      .rejects.toBeInstanceOf(RevisionConflictError)
    await expect(mutateSaveGameAtomic(userIds[2]!, 'business-b', 'business:one', 1, {}, () => {}))
      .rejects.toBeInstanceOf(BusinessKeyConflictError)
  })

  it('replays the exact item-transition response after later commits', async () => {
    const { getPersistedGameV3, mutateSaveGameAtomic, transitionItemAtomic } = await import('../server/utils/savegame')
    const initial = await getPersistedGameV3(userIds[6]!)
    const itemId = initial.stash[0]!
    const visitorId = initial.visitRound.slots.find((slot) => slot.visitor)?.visitor?.id ?? 'missing'
    const command = { operation: 'sell' as const, itemId, targetId: visitorId }
    const first = await transitionItemAtomic(userIds[6]!, 'transition-replay', 0, command)
    await mutateSaveGameAtomic(userIds[6]!, 'later-command', 'later:credit', 1, { amount: 1 }, (save) => { save.gold += 1 })
    const replay = await transitionItemAtomic(userIds[6]!, 'transition-replay', 0, command)
    expect(replay).toEqual(first)
    expect(replay.revision).toBe(1)
  })

  it('reloads and projects custody, records material conservation and permits a new loan instance', async () => {
    const { getPersistedGameV3, transitionItemAtomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const custody = await getPersistedGameV3(userIds[7]!)
    const itemId = custody.stash[0]!
    addExpedition(custody, 'expedition-a')
    addExpedition(custody, 'expedition-b', 1)
    await collection.replaceOne({ userId: userIds[7] }, custody)
    await transitionItemAtomic(userIds[7]!, 'mongo-loan-a', 0, { operation: 'loan', itemId, targetId: 'expedition-a' })
    const projected = mapPersistedGameToGameView(await getPersistedGameV3(userIds[7]!), new Date('2026-09-13T12:00:00.000Z'))
    expect(projected.expeditions).toContainEqual(expect.objectContaining({ expeditionId: 'expedition-a' }))
    expect(projected.items).toContainEqual(expect.objectContaining({ itemId, custody: expect.objectContaining({ expeditionId: 'expedition-a' }) }))
    await transitionItemAtomic(userIds[7]!, 'mongo-return-a', 1, { operation: 'return', itemId, targetId: 'expedition-a' })
    expect((await getPersistedGameV3(userIds[7]!)).expeditionsById['expedition-a']).toBeDefined()
    await transitionItemAtomic(userIds[7]!, 'mongo-loan-b', 2, { operation: 'loan', itemId, targetId: 'expedition-b' })

    const materials = await getPersistedGameV3(userIds[8]!)
    const dismantledId = materials.stash[0]!
    await transitionItemAtomic(userIds[8]!, 'mongo-dismantle', 0, { operation: 'dismantle', itemId: dismantledId, targetId: 'scrap' })
    const persisted = await collection.findOne({ userId: userIds[8] })
    expect(persisted?.ledger[0].materialDeltas.scrap).toBe(persisted?.materials.scrap)
  })

  it('persists the real commission pending reward before claiming it', async () => {
    const { getPersistedGameV3, getSaveGame, mutateSaveGameAtomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const { assignVisitorCommission, claimVisitorCommission } = await import('../utils/visitor-logic')
    const initial = await getPersistedGameV3(userIds[11]!)
    const visitorId = initial.visitRound.slots.find((slot) => slot.visitor)?.visitor?.id!
    const start = new Date('2026-09-13T00:00:00.000Z')
    const dependencies = { now: () => start, random: () => 0, uuid: () => 'mongo-pending-flow' }
    await mutateSaveGameAtomic(userIds[11]!, 'mongo-assign-flow', 'commission:assign:mongo-flow', 0, {}, (save) => {
      const visitor = save.visitRound.slots.find((slot) => slot.visitor?.id === visitorId)!.visitor!
      visitor.state = 'traded'
      assignVisitorCommission(save, visitorId, 'safe', () => 0, start)
    }, dependencies)
    const assigned = await getPersistedGameV3(userIds[11]!)
    const finish = assigned.visitRound.slots.find((slot) => slot.visitor?.id === visitorId)!.visitor!.commission!.finishesAt
    const reconcileDependencies = { ...dependencies, now: () => new Date(finish) }
    await getSaveGame(userIds[11]!, reconcileDependencies)
    const ready = await getPersistedGameV3(userIds[11]!)
    const commission = ready.visitRound.slots.find((slot) => slot.visitor?.id === visitorId)!.visitor!.commission!
    const rewardItemId = commission.rewardItemId!
    const view = mapPersistedGameToGameView(ready, new Date(finish))
    expect(view.settlements).toContainEqual(expect.objectContaining({ settlementId: commission.id }))
    expect(ready.itemPlacements[rewardItemId]).toMatchObject({ ownerKind: 'caravan', custodyKind: 'settlement' })
    await mutateSaveGameAtomic(userIds[11]!, 'mongo-claim-flow', 'commission:claim:mongo-flow', ready.revision, {}, (save) => {
      claimVisitorCommission(save, visitorId, new Date(finish))
    }, reconcileDependencies)
    const claimed = await getPersistedGameV3(userIds[11]!)
    expect(claimed.stash.filter((itemId) => itemId === rewardItemId)).toHaveLength(1)
    expect(claimed.itemPlacements[rewardItemId]).toMatchObject({ ownerKind: 'caravan', custodyKind: 'stash' })
  })

  it('preserves normative service custody through a generic Mongo mutation', async () => {
    const { getPersistedGameV3, mutateEquipmentV2Atomic, mutateSaveGameAtomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3(userIds[12]!)
    const itemId = initial.stash[0]!
    const deps = fixedDeps()
    const blacksmith = executionOption(mapPersistedGameToGameView(initial, deps.now()), itemId, 'queue_blacksmith_job')
    const queued = await mutateEquipmentV2Atomic(userIds[12]!, 'mongo-service-item', 0, {
      action: 'queue_blacksmith_job', itemId, optionId: blacksmith.optionId
    }, deps)
    const jobId = Object.keys(queued.serviceJobStateById)[0]!
    await mutateSaveGameAtomic(userIds[12]!, 'mongo-generic', 'generic:gold', queued.revision, {}, (save) => { save.gold += 1 }, deps)
    const reloaded = await getPersistedGameV3(userIds[12]!)
    expect(reloaded.itemPlacements[itemId]).toEqual({ ownerKind: 'caravan', custodyKind: 'service', custodyId: jobId })
    expect(reloaded.serviceJobsById[jobId]?.itemIds).toEqual([itemId])
    expect(reloaded.serviceJobStateById[jobId]).toMatchObject({ status: 'active', itemId, service: 'blacksmith' })
  })

  it('returns the final retained loan after its visitor ages out and prunes the lifecycle', async () => {
    const { getPersistedGameV3, mutateSaveGameAtomic, transitionItemAtomic } = await import('../server/utils/savegame')
    const { retainedLifecycle, itemId, visitorId, historicalName, departedAt } = await createLegacyRetainedLifecycle(userIds[13]!)
    await collection.replaceOne({ userId: userIds[13] }, retainedLifecycle)
    const backfilled = await getPersistedGameV3(userIds[13]!)
    expect(backfilled.expeditionsById['retained-expedition']?.projection).toEqual(expect.objectContaining({
      retainedVisitor: { name: historicalName, departedAt }
    }))
    await mutateSaveGameAtomic(userIds[13]!, 'unrelated-gold', 'generic:retained-stability', 1, {}, (save) => { save.gold += 1 })
    const retained = await getPersistedGameV3(userIds[13]!)
    expect(retained.visitHistory.flatMap((round) => round.slots).some((slot) => slot.visitor?.id === visitorId)).toBe(false)
    expect(retained.expeditionsById['retained-expedition']?.itemIds).toEqual([itemId])
    expect(retained.expeditionsById['retained-expedition']?.projection).toEqual(expect.objectContaining({
      retainedVisitor: { name: historicalName, departedAt }
    }))

    vi.doMock('../server/utils/auth', () => ({
      requireUser: async () => ({ id: userIds[13]!, email: 'retained@example.test' })
    }))
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    const { default: getGameHandler } = await import('../server/api/v2/game.get')
    const retainedView = await getGameHandler({} as never)
    expect(retainedView.visitors).toContainEqual(expect.objectContaining({
      visitorId,
      name: { key: `visitor.${visitorId}`, fallback: historicalName },
      state: 'departed',
      departedAt,
      lastExpeditionId: 'retained-expedition'
    }))
    expect(retainedView.expeditions).toContainEqual(expect.objectContaining({
      expeditionId: 'retained-expedition', visitorId
    }))

    const revisionBeforeReturn = (await getPersistedGameV3(userIds[13]!)).revision
    await transitionItemAtomic(userIds[13]!, 'return-retained', revisionBeforeReturn, { operation: 'return', itemId, targetId: 'retained-expedition' })
    const returned = await getPersistedGameV3(userIds[13]!)
    expect(returned.stash).toContain(itemId)
    expect(returned.expeditionsById['retained-expedition']).toBeUndefined()
    const returnedView = await getGameHandler({} as never)
    expect(returnedView.expeditions).not.toContainEqual(expect.objectContaining({ expeditionId: 'retained-expedition' }))
    expect(returnedView.visitors).not.toContainEqual(expect.objectContaining({ visitorId }))
  })

  it.each([
    ['absent', userIds[14]!],
    ['malformed', userIds[15]!]
  ])('rejects an %s replay source with the typed corruption error', async (sourceKind, userId) => {
    const { getPersistedGameV3, PersistedGameCorruptError } = await import('../server/utils/savegame')
    const { retainedLifecycle } = await createLegacyRetainedLifecycle(userId)
    const corrupt = structuredClone(retainedLifecycle) as unknown as Record<string, unknown>
    if (sourceKind === 'absent') delete corrupt.requestRecords
    else corrupt.requestRecords = [undefined]
    await collection.replaceOne({ userId }, corrupt)

    await expect(getPersistedGameV3(userId)).rejects.toBeInstanceOf(PersistedGameCorruptError)
  })

  it('converges concurrent backfill readers without changing aggregate identity or economics', async () => {
    const { getPersistedGameV3, isPersistedCanonical } = await import('../server/utils/savegame')
    const userId = userIds[16]!
    const { retainedLifecycle, historicalName, departedAt } = await createLegacyRetainedLifecycle(userId)
    await collection.replaceOne({ userId }, retainedLifecycle)
    const before = await collection.findOne({ userId })
    if (!before) throw new Error('Expected recoverable document')

    let initialReads = 0
    let releaseReaders!: () => void
    const bothRead = new Promise<void>((resolve) => { releaseReaders = resolve })
    repositoryCollection = {
      findOne: async (...args: Parameters<Collection['findOne']>) => {
        const found = await collection.findOne(...args)
        initialReads += 1
        if (initialReads === 2) releaseReaders()
        else if (initialReads < 2) await bothRead
        return found
      },
      replaceOne: (...args: Parameters<Collection['replaceOne']>) => collection.replaceOne(...args)
    } as unknown as Collection

    let readers: PersistedGameV3[]
    try {
      readers = await Promise.all([getPersistedGameV3(userId), getPersistedGameV3(userId)])
    } finally {
      repositoryCollection = collection
    }

    const after = await collection.findOne({ userId })
    expect(after).not.toBeNull()
    expect(isPersistedCanonical(after)).toBe(true)
    expect(await collection.countDocuments({ userId })).toBe(1)
    expect(readers[0]).toEqual(readers[1])
    expect(readers[0]?.expeditionsById['retained-expedition']?.projection).toEqual(expect.objectContaining({
      retainedVisitor: { name: historicalName, departedAt }
    }))
    expect(after?._id).toEqual(before._id)
    expect(after?.revision).toBe(before.revision)
    expect(after?.gold).toBe(before.gold)
    expect(after?.materials).toEqual(before.materials)
    expect(after?.ledger).toEqual(before.ledger)
    expect(after?.businessKeys).toEqual(before.businessKeys)
    expect(after?.expeditionsById['retained-expedition'].projection.retainedVisitor)
      .toEqual({ name: historicalName, departedAt })
  })

  it('converges concurrent historical reward backfill readers and stays idempotent', async () => {
    const { getPersistedGameV3, isPersistedCanonical } = await import('../server/utils/savegame')
    const userId = userIds[23]!
    const legacyV3 = await createHistoricalClaimedRewardFixture(userId)
    await collection.replaceOne({ userId }, legacyV3, { upsert: true })
    const before = await collection.findOne({ userId })
    if (!before) throw new Error('Expected recoverable historical reward document')

    let initialReads = 0
    let replacements = 0
    let releaseReaders!: () => void
    const bothRead = new Promise<void>((resolve) => { releaseReaders = resolve })
    repositoryCollection = {
      findOne: async (...args: Parameters<Collection['findOne']>) => {
        const found = await collection.findOne(...args)
        initialReads += 1
        if (initialReads === 2) releaseReaders()
        else if (initialReads < 2) await bothRead
        return found
      },
      replaceOne: async (...args: Parameters<Collection['replaceOne']>) => {
        replacements += 1
        return collection.replaceOne(...args)
      }
    } as unknown as Collection

    let readers: PersistedGameV3[]
    try {
      readers = await Promise.all([getPersistedGameV3(userId), getPersistedGameV3(userId)])
      await getPersistedGameV3(userId)
    } finally {
      repositoryCollection = collection
    }

    const after = await collection.findOne({ userId })
    expect(after).not.toBeNull()
    expect(isPersistedCanonical(after)).toBe(true)
    expect(readers[0]).toEqual(readers[1])
    expect(replacements).toBe(2)
    expect(after?._id).toEqual(before._id)
    expect(after?.revision).toBe(before.revision)
    expect(after?.gold).toBe(before.gold)
    expect(after?.materials).toEqual(before.materials)
    expect(after?.itemsById).toEqual(before.itemsById)
    expect(after?.visitRound).toEqual(before.visitRound)
    expect(after?.visitHistory).toEqual(before.visitHistory)
    expect(after?.ledger).toEqual(before.ledger)
    expect(after?.requestRecords).toEqual(before.requestRecords)
    expect(after?.businessKeys).toEqual(before.businessKeys)
    expect(after?.stash).not.toContain('historical-sold-reward')
    expect(after?.itemPlacements['historical-moved-reward']).toEqual(before.itemPlacements['historical-moved-reward'])
    expect(after?.itemPlacements['historical-sold-reward']).toEqual(before.itemPlacements['historical-sold-reward'])
    expect(after?.itemV2ById['historical-moved-reward'].provenance.businessKey)
      .toBe('loot:historical-moved-commission:reward')
    expect(after?.itemV2ById['historical-sold-reward'].provenance.businessKey)
      .toBe('loot:historical-sold-commission:reward')
  })

  it('recovers the committed response after the repository driver throws', async () => {
    const { getPersistedGameV3, transitionItemAtomic } = await import('../server/utils/savegame')
    const initial = await getPersistedGameV3(userIds[9]!)
    const itemId = initial.stash[0]!
    addExpedition(initial, 'uncertain-expedition')
    await collection.replaceOne({ userId: userIds[9] }, initial)
    repositoryCollection = {
      findOne: (...args: Parameters<Collection['findOne']>) => collection.findOne(...args),
      replaceOne: async (...args: Parameters<Collection['replaceOne']>) => {
        await collection.replaceOne(...args)
        throw new Error('simulated Mongo network loss after acknowledged server commit')
      }
    } as unknown as Collection
    try {
      const response = await transitionItemAtomic(userIds[9]!, 'mongo-uncertain', 0, { operation: 'loan', itemId, targetId: 'uncertain-expedition' })
      expect(response.revision).toBe(1)
      expect((await collection.findOne({ userId: userIds[9] }))?.ledger).toHaveLength(1)
    } finally {
      repositoryCollection = collection
    }
  })

  it('replays an equipment V2 snapshot after reload and later commits', async () => {
    const { getPersistedGameV3, mutateEquipmentV2Atomic, mutateSaveGameAtomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const userId = userIds[17]!
    const initial = await getPersistedGameV3(userId)
    const itemId = initial.stash[0]!
    initial.itemsById[itemId]!.identified = false
    initial.itemsById[itemId]!.rarity = 'magic'
    await collection.replaceOne({ userId }, initial)
    const deps = fixedDeps()
    const identify = executionOption(mapPersistedGameToGameView(initial, deps.now()), itemId, 'identify_item')
    const first = await mutateEquipmentV2Atomic(userId, 'mongo-identify-replay', 0, {
      action: 'identify_item', itemId, optionId: identify.optionId
    }, deps)
    await mutateSaveGameAtomic(userId, 'mongo-after-equipment', 'mongo:after-equipment', 1, {}, (save) => { save.gold += 1 }, deps)

    const replay = await mutateEquipmentV2Atomic(userId, 'mongo-identify-replay', 0, {
      action: 'identify_item', itemId, optionId: identify.optionId
    }, deps)

    expect(replay.revision).toBe(first.revision)
    expect(replay.gold).toBe(first.gold)
    expect(replay.itemsById[itemId]!.identified).toBe(true)
  })

  it('recovers an uncertain equipment V2 response after Mongo acknowledges then throws', async () => {
    const { getPersistedGameV3, mutateEquipmentV2Atomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const userId = userIds[18]!
    const initial = await getPersistedGameV3(userId)
    const itemId = initial.stash[0]!
    initial.itemsById[itemId]!.identified = false
    initial.itemsById[itemId]!.rarity = 'magic'
    await collection.replaceOne({ userId }, initial)
    const deps = fixedDeps()
    const identify = executionOption(mapPersistedGameToGameView(initial, deps.now()), itemId, 'identify_item')
    repositoryCollection = {
      findOne: (...args: Parameters<Collection['findOne']>) => collection.findOne(...args),
      replaceOne: async (...args: Parameters<Collection['replaceOne']>) => {
        await collection.replaceOne(...args)
        throw new Error('simulated Mongo network loss after equipment commit')
      }
    } as unknown as Collection
    try {
      const response = await mutateEquipmentV2Atomic(userId, 'mongo-equipment-uncertain', 0, {
        action: 'identify_item', itemId, optionId: identify.optionId
      }, deps)
      expect(response.revision).toBe(1)
      expect((await collection.findOne({ userId }))?.ledger).toHaveLength(1)
    } finally {
      repositoryCollection = collection
    }
  })

  it('allows one Mongo CAS winner for concurrent equipment commands', async () => {
    const { getPersistedGameV3, mutateEquipmentV2Atomic, RevisionConflictError } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const userId = userIds[19]!
    const initial = await getPersistedGameV3(userId)
    const itemId = initial.stash[0]!
    initial.itemsById[itemId]!.identified = false
    initial.itemsById[itemId]!.rarity = 'magic'
    await collection.replaceOne({ userId }, initial)
    const deps = fixedDeps()
    const view = mapPersistedGameToGameView(initial, deps.now())
    const identify = executionOption(view, itemId, 'identify_item')
    const dismantle = executionOption(view, itemId, 'dismantle_item')

    const results = await Promise.allSettled([
      mutateEquipmentV2Atomic(userId, 'mongo-equipment-identify', 0, {
        action: 'identify_item', itemId, optionId: identify.optionId
      }, deps),
      mutateEquipmentV2Atomic(userId, 'mongo-equipment-dismantle', 0, {
        action: 'dismantle_item', itemId, optionId: dismantle.optionId, acknowledgementId: dismantle.acknowledgementId
      }, deps)
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)
      .toBeInstanceOf(RevisionConflictError)
    expect((await collection.findOne({ userId }))?.ledger).toHaveLength(1)
  })

  it('persists equipment job completion and V2 tombstone material deltas', async () => {
    const { getPersistedGameV3, mutateEquipmentV2Atomic, reconcilePersistedGameV3 } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const userId = userIds[20]!
    const initial = await getPersistedGameV3(userId)
    const [jobItemId, tombstoneItemId] = initial.stash
    if (!jobItemId || !tombstoneItemId) throw new Error('Expected two starter items')
    const deps = fixedDeps()
    const blacksmith = executionOption(mapPersistedGameToGameView(initial, deps.now()), jobItemId, 'queue_blacksmith_job')
    const queued = await mutateEquipmentV2Atomic(userId, 'mongo-queue-blacksmith', 0, {
      action: 'queue_blacksmith_job', itemId: jobItemId, optionId: blacksmith.optionId
    }, deps)
    const jobId = Object.keys(queued.serviceJobStateById)[0]!
    const completed = await reconcilePersistedGameV3(userId, fixedDeps(new Date('2026-09-15T12:02:00.000Z')))
    expect(completed.serviceJobStateById[jobId]!.status).toBe('completed')
    expect(completed.itemPlacements[jobItemId]).toMatchObject({ ownerKind: 'caravan', custodyKind: 'stash' })

    const dismantle = executionOption(mapPersistedGameToGameView(completed, deps.now()), tombstoneItemId, 'dismantle_item')
    await mutateEquipmentV2Atomic(userId, 'mongo-v2-dismantle', completed.revision, {
      action: 'dismantle_item', itemId: tombstoneItemId, optionId: dismantle.optionId, acknowledgementId: dismantle.acknowledgementId
    }, deps)
    const persisted = await collection.findOne({ userId })
    expect(persisted?.itemPlacements[tombstoneItemId]).toMatchObject({ ownerKind: 'tombstone', custodyKind: 'tombstone' })
    expect(persisted?.ledger.at(-1).materialDeltas.scrap).toBeGreaterThan(0)
  })

  it('replays an equipment V2 mutation against the configured reward after reload and later commits', async () => {
    const { mutateEquipmentV2Atomic, mutateSaveGameAtomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const userId = userIds[21]!
    const claimed = await claimConfiguredMongoReward(userId)
    const rewardItemId = claimed.rewardItemId
    const deps = fixedDeps()
    const identify = executionOption(mapPersistedGameToGameView(claimed.persisted, deps.now()), rewardItemId, 'identify_item')

    const first = await mutateEquipmentV2Atomic(userId, 'mongo-reward-identify', claimed.persisted.revision, {
      action: 'identify_item', itemId: rewardItemId, optionId: identify.optionId
    }, deps)
    await mutateSaveGameAtomic(userId, 'mongo-after-reward', 'mongo:after-reward', first.revision, {}, (save) => { save.gold += 1 }, deps)
    const replay = await mutateEquipmentV2Atomic(userId, 'mongo-reward-identify', claimed.persisted.revision, {
      action: 'identify_item', itemId: rewardItemId, optionId: identify.optionId
    }, deps)

    expect(replay.revision).toBe(first.revision)
    expect(replay.itemsById[rewardItemId]!.identified).toBe(true)
  })

  it('allows one Mongo CAS winner for concurrent equipment commands against the configured reward', async () => {
    const { mutateEquipmentV2Atomic, RevisionConflictError } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const userId = userIds[22]!
    const claimed = await claimConfiguredMongoReward(userId)
    const rewardItemId = claimed.rewardItemId
    const deps = fixedDeps()
    const view = mapPersistedGameToGameView(claimed.persisted, deps.now())
    const identify = executionOption(view, rewardItemId, 'identify_item')
    const dismantle = executionOption(view, rewardItemId, 'dismantle_item')

    const results = await Promise.allSettled([
      mutateEquipmentV2Atomic(userId, 'mongo-reward-identify-cas', claimed.persisted.revision, {
        action: 'identify_item', itemId: rewardItemId, optionId: identify.optionId
      }, deps),
      mutateEquipmentV2Atomic(userId, 'mongo-reward-dismantle-cas', claimed.persisted.revision, {
        action: 'dismantle_item', itemId: rewardItemId, optionId: dismantle.optionId, acknowledgementId: dismantle.acknowledgementId
      }, deps)
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)
      .toBeInstanceOf(RevisionConflictError)
    expect((await collection.findOne({ userId }))?.ledger).toHaveLength(4)
  })

  it('rejects a declared V3 document with legacy or incomplete nested fields', async () => {
    const { getPersistedGameV3, PersistedGameCorruptError } = await import('../server/utils/savegame')
    const corrupt = await getPersistedGameV3(userIds[10]!)
    const itemId = corrupt.stash[0]!
    corrupt.itemsById[itemId] = { id: itemId } as never
    await collection.replaceOne({ userId: userIds[10] }, { ...corrupt, processedRequests: [] })
    await expect(getPersistedGameV3(userIds[10]!)).rejects.toBeInstanceOf(PersistedGameCorruptError)
  })

  it.each([
    ['sell', 'loan', userIds[3]!],
    ['sell', 'dismantle', userIds[4]!],
    ['service', 'loan', userIds[5]!]
  ])('allows one Mongo CAS winner for %s versus %s', async (firstName, secondName, userId) => {
    const { getPersistedGameV3, mutateEquipmentV2Atomic, RevisionConflictError, transitionItemAtomic } = await import('../server/utils/savegame')
    const { mapPersistedGameToGameView } = await import('../server/domain/game-view')
    const initial = await getPersistedGameV3(userId)
    const itemId = initial.stash[0]!
    const visitorId = initial.visitRound.slots.find((slot) => slot.visitor)?.visitor?.id ?? 'missing-visitor'
    const targetFor = (operation: string) => operation === 'sell' ? visitorId : `${operation}-target`
    for (const operation of [firstName, secondName]) {
      const targetId = targetFor(operation)
      if (operation === 'loan') addExpedition(initial, targetId)
    }
    await collection.replaceOne({ userId }, initial)
    const deps = fixedDeps()
    const serviceOption = [firstName, secondName].includes('service')
      ? executionOption(mapPersistedGameToGameView(initial, deps.now()), itemId, 'queue_blacksmith_job')
      : undefined
    const runOperation = (operation: string) => {
      if (operation === 'service') {
        return mutateEquipmentV2Atomic(userId, `${operation}-request`, 0, {
          action: 'queue_blacksmith_job', itemId, optionId: serviceOption!.optionId
        }, deps)
      }
      return transitionItemAtomic(userId, `${operation}-request`, 0, { operation: operation as never, itemId, targetId: targetFor(operation) })
    }
    const results = await Promise.allSettled([
      runOperation(firstName),
      runOperation(secondName)
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toBeInstanceOf(RevisionConflictError)
    const persisted = await collection.findOne({ userId })
    expect(persisted?.ledger).toHaveLength(1)
    expect(persisted?.revision).toBe(1)
    expect(persisted?.ledger[0].itemChanges).toHaveLength(1)
    expect(persisted?.itemPlacements[itemId]).not.toMatchObject({ custodyKind: 'stash' })
    if ([firstName, secondName].includes('service')) {
      const fulfilledIndex = results.findIndex((result) => result.status === 'fulfilled')
      const winner = [firstName, secondName][fulfilledIndex]
      const placement = persisted?.itemPlacements[itemId]
      if (winner === 'service') {
        const jobId = placement?.custodyId
        expect(placement).toEqual({ ownerKind: 'caravan', custodyKind: 'service', custodyId: jobId })
        expect(persisted?.serviceJobsById[jobId!]?.itemIds).toContain(itemId)
        expect(persisted?.serviceJobStateById[jobId!]).toMatchObject({ status: 'active', itemId, service: 'blacksmith' })
      } else {
        const expeditionId = targetFor('loan')
        expect(placement).toEqual({ ownerKind: 'caravan', custodyKind: 'expedition', custodyId: expeditionId })
        expect(persisted?.expeditionsById[expeditionId]?.itemIds).toContain(itemId)
      }
    }
  })

  it('resets schema 2 without importing its economy and keeps the unique index', async () => {
    const { getSaveGame } = await import('../server/utils/savegame')
    await collection.insertOne({ userId: userIds[1], schemaVersion: 2, revision: 4, gold: 999_999, heroes: [{ id: 'old' }] })
    const recreated = await getSaveGame(userIds[1]!)
    const persisted = await collection.findOne({ userId: userIds[1] })
    const indexes = await collection.indexes()
    expect(recreated.gold).toBe(450)
    expect(recreated.revision).toBe(5)
    expect(persisted).not.toHaveProperty('heroes')
    expect(persisted?.itemsById).toBeDefined()
    expect(indexes).toContainEqual(expect.objectContaining({ name: 'userId_unique', unique: true }))
  })
})

function addExpedition(game: PersistedGameV3, id: string, visitorIndex = 0): void {
  const visitor = game.visitRound.slots.flatMap((slot) => slot.visitor ? [slot.visitor] : [])[visitorIndex]
  const visitorId = visitor?.id ?? 'missing'
  if (visitor && !visitor.commission) visitor.commission = {
    ...visitor.commissionOptions[0]!, id: `contract-${id}`, status: 'active',
    startedAt: game.updatedAt, finishesAt: game.updatedAt, outcomeRoll: 0.5
  }
  if (visitor?.commission) visitor.state = 'commissioned'
  const contractId = visitor?.commission?.id ?? `contract-${id}`
  game.expeditionsById[id] = {
    id, itemIds: [], projection: { kind: 'expedition', visitorId, contractId, startsAt: game.updatedAt }
  }
}

function executionOption(view: { items: unknown[] }, itemId: string, action: string) {
  const item = view.items.find((candidate) => (candidate as { itemId?: string }).itemId === itemId) as { actions?: unknown[] } | undefined
  const availability = item?.actions?.find((candidate) => (candidate as { action?: string }).action === action) as { execution?: { options?: unknown[] } } | undefined
  const option = availability?.execution?.options?.[0] as { optionId?: string; acknowledgement?: { acknowledgementId?: string } } | undefined
  if (!option?.optionId) throw new Error(`Missing ${action} option for ${itemId}`)
  return { optionId: option.optionId, acknowledgementId: option.acknowledgement?.acknowledgementId }
}

function fixedDeps(now = new Date('2026-09-15T12:00:00.000Z')) {
  return { now: () => now, uuid: () => 'mongo-fixed-id', random: () => 0.5 }
}

async function createLegacyRetainedLifecycle(userId: string): Promise<{
  retainedLifecycle: PersistedGameV3
  itemId: string
  visitorId: string
  historicalName: string
  departedAt: string
}> {
  const { buildPersistedFromPublic, getPersistedGameV3, hydratePersistedGame, mutateSaveGameAtomic } = await import('../server/utils/savegame')
  const { applyItemTransition } = await import('../server/domain/item-transitions')
  const initial = await getPersistedGameV3(userId)
  addExpedition(initial, 'retained-expedition')
  const visitor = initial.visitRound.slots.find((slot) => slot.visitor?.commission)?.visitor!
  visitor.commission!.id = 'retained-expedition'
  const initialProjection = initial.expeditionsById['retained-expedition']!.projection
  if (initialProjection?.kind !== 'expedition') throw new Error('Expected retained expedition projection')
  initialProjection.contractId = 'retained-expedition'
  const itemId = initial.stash[0]!
  const loaned = applyItemTransition(initial, { operation: 'loan', itemId, targetId: 'retained-expedition' }).game
  const historicalName = visitor.name
  const departedAt = new Date(Date.parse(visitor.commission!.finishesAt) + 60_000).toISOString()
  const departedVisitor = loaned.visitRound.slots.find((slot) => slot.visitor?.id === visitor.id)?.visitor!
  departedVisitor.state = 'departed'
  departedVisitor.departedAt = departedAt
  departedVisitor.commission!.status = 'claimed'
  departedVisitor.commission!.outcome = 'partial'
  departedVisitor.commission!.rewardGold = departedVisitor.commission!.partialRewardGold
  departedVisitor.commission!.claimedAt = departedAt
  loaned.settlementsById['retained-expedition'] = {
    id: 'retained-expedition', itemIds: [],
    projection: {
      kind: 'settlement', expeditionId: 'retained-expedition', outcome: 'retreated',
      appliedAt: departedVisitor.commission!.finishesAt
    }
  }
  const departed = buildPersistedFromPublic(hydratePersistedGame(loaned), loaned)
  await collection.replaceOne({ userId }, departed)
  await mutateSaveGameAtomic(userId, 'capture-departed', 'generic:capture-departed', 0, {}, () => {})
  const withReplay = await getPersistedGameV3(userId)
  const aged = hydratePersistedGame(withReplay)
  aged.visitHistory = []
  aged.visitRound = {
    id: 'empty-current', number: 99,
    slots: [{ id: 'visitor-slot-1' }, { id: 'visitor-slot-2' }], createdAt: aged.updatedAt
  }
  const retainedLifecycle = buildPersistedFromPublic(aged, withReplay)
  const legacyProjection = retainedLifecycle.expeditionsById['retained-expedition']!.projection
  if (legacyProjection?.kind !== 'expedition') throw new Error('Expected retained expedition projection')
  delete legacyProjection.retainedVisitor
  return { retainedLifecycle, itemId, visitorId: visitor.id, historicalName, departedAt }
}

async function createHistoricalClaimedRewardFixture(userId: string): Promise<Omit<PersistedGameV3, 'itemV2ById' | 'serviceJobStateById'>> {
  const { getPersistedGameV3 } = await import('../server/utils/savegame')
  const persisted = await getPersistedGameV3(userId)
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

async function claimConfiguredMongoReward(userId: string): Promise<{ persisted: PersistedGameV3; rewardItemId: string; visitorId: string }> {
  const { getPersistedGameV3, getSaveGame, mutateSaveGameAtomic } = await import('../server/utils/savegame')
  const { assignVisitorCommission, claimVisitorCommission } = await import('../utils/visitor-logic')
  const initial = await getPersistedGameV3(userId)
  const visitorId = initial.visitRound.slots.find((slot) => slot.visitor)?.visitor?.id!
  const start = new Date('2026-09-13T00:00:00.000Z')
  const deps = fixedDeps(start)
  await mutateSaveGameAtomic(userId, 'mongo-reward-assign', `mongo:reward-assign:${userId}`, initial.revision, {}, (save) => {
    const visitor = save.visitRound.slots.find((slot) => slot.visitor?.id === visitorId)!.visitor!
    visitor.state = 'traded'
    assignVisitorCommission(save, visitorId, 'safe', () => 0, start)
  }, deps)
  const assigned = await getPersistedGameV3(userId)
  const commission = assigned.visitRound.slots.find((slot) => slot.visitor?.id === visitorId)!.visitor!.commission!
  await getSaveGame(userId, fixedDeps(new Date(commission.finishesAt)))
  const ready = await getPersistedGameV3(userId)
  await mutateSaveGameAtomic(userId, 'mongo-reward-claim', `mongo:reward-claim:${userId}`, ready.revision, {}, (save) => {
    claimVisitorCommission(save, visitorId, new Date(commission.finishesAt))
  }, fixedDeps(new Date(commission.finishesAt)))
  const persisted = await getPersistedGameV3(userId)
  const rewardItemId = [persisted.visitRound, ...persisted.visitHistory]
    .flatMap((round) => round.slots)
    .find((slot) => slot.visitor?.id === visitorId)!.visitor!.commission!.rewardItemId!
  return { persisted, rewardItemId, visitorId }
}
