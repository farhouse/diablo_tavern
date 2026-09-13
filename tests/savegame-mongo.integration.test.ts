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
const userIds = [`${prefix}-replay`, `${prefix}-reset`, `${prefix}-business`, `${prefix}-sell-loan`, `${prefix}-sell-dismantle`, `${prefix}-service-loan`, `${prefix}-transition-replay`, `${prefix}-custody`, `${prefix}-materials`, `${prefix}-uncertain`, `${prefix}-corrupt`, `${prefix}-commission-flow`, `${prefix}-service-roundtrip`]

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
    addExpedition(custody, 'expedition-b')
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
    const { getPersistedGameV3, mutateSaveGameAtomic, transitionItemAtomic } = await import('../server/utils/savegame')
    const initial = await getPersistedGameV3(userIds[12]!)
    const itemId = initial.stash[0]!
    initial.serviceJobsById['mongo-service'] = {
      id: 'mongo-service', itemIds: [],
      projection: { kind: 'service', service: 'blacksmith', queuedAt: initial.updatedAt, startsAt: initial.updatedAt }
    }
    await collection.replaceOne({ userId: userIds[12] }, initial)
    await transitionItemAtomic(userIds[12]!, 'mongo-service-item', 0, { operation: 'service', itemId, targetId: 'mongo-service' })
    await mutateSaveGameAtomic(userIds[12]!, 'mongo-generic', 'generic:gold', 1, {}, (save) => { save.gold += 1 })
    const reloaded = await getPersistedGameV3(userIds[12]!)
    expect(reloaded.itemPlacements[itemId]).toEqual({ ownerKind: 'caravan', custodyKind: 'service', custodyId: 'mongo-service' })
    expect(reloaded.serviceJobsById['mongo-service']?.itemIds).toEqual([itemId])
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
    const { getPersistedGameV3, transitionItemAtomic } = await import('../server/utils/savegame')
    const initial = await getPersistedGameV3(userId)
    const itemId = initial.stash[0]!
    const visitorId = initial.visitRound.slots.find((slot) => slot.visitor)?.visitor?.id ?? 'missing-visitor'
    const targetFor = (operation: string) => operation === 'sell' ? visitorId : `${operation}-target`
    for (const operation of [firstName, secondName]) {
      const targetId = targetFor(operation)
      if (operation === 'loan') addExpedition(initial, targetId)
      if (operation === 'service') initial.serviceJobsById[targetId] = {
        id: targetId, itemIds: [], projection: { kind: 'service', service: 'blacksmith', queuedAt: initial.updatedAt, startsAt: initial.updatedAt }
      }
    }
    await collection.replaceOne({ userId }, initial)
    const results = await Promise.allSettled([
      transitionItemAtomic(userId, `${firstName}-request`, 0, { operation: firstName as never, itemId, targetId: targetFor(firstName) }),
      transitionItemAtomic(userId, `${secondName}-request`, 0, { operation: secondName as never, itemId, targetId: targetFor(secondName) })
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const persisted = await collection.findOne({ userId })
    expect(persisted?.ledger).toHaveLength(1)
    expect(persisted?.revision).toBe(1)
    expect(persisted?.ledger[0].itemChanges).toHaveLength(1)
    expect(persisted?.itemPlacements[itemId]).not.toMatchObject({ custodyKind: 'stash' })
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

function addExpedition(game: PersistedGameV3, id: string): void {
  const visitor = game.visitRound.slots.find((slot) => slot.visitor)?.visitor
  const visitorId = visitor?.id ?? 'missing'
  if (visitor && !visitor.commission) visitor.commission = {
    ...visitor.commissionOptions[0]!, id: `contract-${id}`, status: 'active',
    startedAt: game.updatedAt, finishesAt: game.updatedAt, outcomeRoll: 0.5
  }
  const contractId = visitor?.commission?.id ?? `contract-${id}`
  game.expeditionsById[id] = {
    id, itemIds: [], projection: { kind: 'expedition', visitorId, contractId, startsAt: game.updatedAt }
  }
}
