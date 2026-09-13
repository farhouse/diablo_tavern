import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SaveGame } from '../types/game'
import { createSaveGame } from '../utils/game-logic'
import type { PersistedGameV3 } from '../server/utils/savegame'

let document: PersistedGameV3 | Record<string, unknown> | undefined
let uncertainCommit = false

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
    const { buildPersistedFromPublic } = await import('../server/utils/savegame')
    document = buildPersistedFromPublic(createSaveGame('atomic-user'))
    uncertainCommit = false
    vi.clearAllMocks()
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

  it('records material deltas and permits a later transition instance for the same item', async () => {
    const { getPersistedGameV3, transitionItemAtomic } = await import('../server/utils/savegame')
    const initial = await getPersistedGameV3('atomic-user')
    const itemId = initial.stash[0]!
    initial.expeditionsById['expedition-a'] = { id: 'expedition-a', itemIds: [] }
    initial.expeditionsById['expedition-b'] = { id: 'expedition-b', itemIds: [] }
    document = initial

    await transitionItemAtomic('atomic-user', 'loan-a', 0, { operation: 'loan', itemId, targetId: 'expedition-a' })
    await transitionItemAtomic('atomic-user', 'return-a', 1, { operation: 'return', itemId, targetId: 'expedition-a' })
    await transitionItemAtomic('atomic-user', 'loan-b', 2, { operation: 'loan', itemId, targetId: 'expedition-b' })
    const secondItem = (document as PersistedGameV3).stash.find((id) => id !== itemId)!
    await transitionItemAtomic('atomic-user', 'dismantle', 3, { operation: 'dismantle', itemId: secondItem, targetId: 'scrap' })

    expect((document as PersistedGameV3).ledger.at(-1)?.materialDeltas.scrap).toBeGreaterThan(0)
    expect((document as PersistedGameV3).ledger.map((entry) => entry.businessKey)).toContain(JSON.stringify(['item-transition', 'loan', itemId, 'expedition-b']))
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
    const { mutateSaveGameAtomic } = await import('../server/utils/savegame')
    const persisted = document as PersistedGameV3
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
    persisted.requestRecords.push(
      { requestId: 'expired', operationKey: 'expired', businessKey: 'expired', commandHash: 'b'.repeat(64), response: {} as never, revision: 1, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z' },
      { requestId: 'recent', operationKey: 'recent', businessKey: 'recent', commandHash: 'c'.repeat(64), response: {} as never, revision: 1, createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z' }
    )
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-13T00:00:00.000Z'))
    try {
      await mutateSaveGameAtomic('atomic-user', 'fresh', 'fresh:key', 510, {}, () => {})
    } finally {
      vi.useRealTimers()
    }
    expect((document as PersistedGameV3).ledger).toHaveLength(511)
    expect((document as PersistedGameV3).requestRecords.map((entry) => entry.requestId)).toEqual(['recent', 'fresh'])
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
})
