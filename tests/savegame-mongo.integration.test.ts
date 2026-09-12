import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoClient, type Collection } from 'mongodb'
import type { SaveGame } from '../types/game'

const mongoUri = process.env.MONGO_TEST_URI
const suite = mongoUri ? describe : describe.skip
let client: MongoClient
let collection: Collection
const userIds = ['alta16-cas-reload', 'alta16-legacy-reset']

vi.mock('../server/utils/db', () => ({
  saveGamesCollection: async () => collection
}))

suite('save aggregate with real MongoDB', () => {
  beforeAll(async () => {
    client = new MongoClient(mongoUri!)
    await client.connect()
    collection = client.db('diablo_tavern_alta16_integration').collection('savegames')
    await collection.createIndex({ userId: 1 }, { unique: true })
    await collection.deleteMany({ userId: { $in: userIds } })
  })

  afterAll(async () => {
    if (!client) return
    await collection.deleteMany({ userId: { $in: userIds } })
    await client.close()
  })

  it('serializes concurrent retries once and reloads the exact persisted aggregate', async () => {
    const { getSaveGame, mutateSaveGameAtomic } = await import('../server/utils/savegame')
    const created = await getSaveGame(userIds[0]!)
    const visitorId = created.visitRound.slots[0]!.visitor!.id
    const operationKey = `mongo-credit:${visitorId}`
    const mutate = (save: SaveGame) => { save.gold += 37 }

    const [first, retry] = await Promise.all([
      mutateSaveGameAtomic(userIds[0]!, 'mongo-request-1', operationKey, mutate),
      mutateSaveGameAtomic(userIds[0]!, 'mongo-request-1', operationKey, mutate)
    ])
    const reloaded = await getSaveGame(userIds[0]!)

    expect(first.gold).toBe(487)
    expect(retry.gold).toBe(487)
    expect(reloaded).toEqual(retry)
    expect(reloaded.processedRequests).toEqual([{ requestId: 'mongo-request-1', operationKey }])
    expect(reloaded.revision).toBe(1)
  })

  it('replaces an incompatible document instead of importing legacy wealth or heroes', async () => {
    const { getSaveGame } = await import('../server/utils/savegame')
    await collection.insertOne({
      userId: userIds[1],
      gold: 999_999,
      heroes: [{ id: 'old-hero' }],
      activeExpeditions: [{ id: 'old-run' }],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z'
    })

    const recreated = await getSaveGame(userIds[1]!)
    const persisted = await collection.findOne({ userId: userIds[1] })

    expect(recreated.gold).toBe(450)
    expect(recreated.schemaVersion).toBe(2)
    expect(recreated).not.toHaveProperty('heroes')
    expect(persisted).not.toHaveProperty('heroes')
    expect(persisted).not.toHaveProperty('activeExpeditions')
  })
})
