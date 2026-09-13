import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoClient, type Collection } from 'mongodb'
import type { SaveGame } from '../types/game'

const mongoUri = process.env.MONGO_TEST_URI
const suite = mongoUri ? describe : describe.skip
let client: MongoClient
let collection: Collection
const prefix = `alta43-${process.pid}`
const userIds = [`${prefix}-replay`, `${prefix}-reset`, `${prefix}-business`, `${prefix}-sell-loan`, `${prefix}-sell-dismantle`, `${prefix}-service-loan`]

vi.mock('../server/utils/db', () => ({ saveGamesCollection: async () => collection }))

suite('PersistedGameV3 against isolated real MongoDB', () => {
  beforeAll(async () => {
    client = new MongoClient(mongoUri!)
    await client.connect()
    collection = client.db('diablo_tavern_alta43_integration').collection('savegames')
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
      if (operation === 'loan') initial.expeditionsById[targetId] = { id: targetId, itemIds: [] }
      if (operation === 'service') initial.serviceJobsById[targetId] = { id: targetId, itemIds: [] }
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
