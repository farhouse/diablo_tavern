import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SaveGame } from '../types/game'
import { createSaveGame } from '../utils/game-logic'

let document: SaveGame | undefined
let forcedConflict = false

const collection = {
  findOne: vi.fn(async () => document ? structuredClone(document) : null),
  updateOne: vi.fn(async (_filter: unknown, update: { $setOnInsert: SaveGame }) => {
    if (!document) document = structuredClone(update.$setOnInsert)
    return { upsertedCount: 1 }
  }),
  replaceOne: vi.fn(async (rawFilter: unknown, replacement: SaveGame) => {
    if (forcedConflict) {
      forcedConflict = false
      return { modifiedCount: 0 }
    }
    const filter = rawFilter as {
      revision?: number
      $or?: Array<{ revision: number | { $exists: boolean } }>
      processedRequestIds?: { $ne: string }
    }
    if (!document) return { modifiedCount: 0 }
    const currentDocument = document
    const revisionMatches = typeof filter.revision === 'number'
      ? currentDocument.revision === filter.revision
      : !filter.$or || filter.$or.some((entry) => typeof entry.revision === 'number'
        ? currentDocument.revision === entry.revision
        : entry.revision.$exists === ('revision' in currentDocument))
    const requestMatches = !filter.processedRequestIds || !currentDocument.processedRequestIds?.includes(filter.processedRequestIds.$ne)
    if (!revisionMatches || !requestMatches) return { modifiedCount: 0 }
    document = structuredClone(replacement)
    return { modifiedCount: 1 }
  })
}

vi.mock('../server/utils/db', () => ({
  saveGamesCollection: async () => collection
}))

describe('atomic save mutation', () => {
  beforeEach(() => {
    document = createSaveGame('atomic-user')
    forcedConflict = false
    vi.clearAllMocks()
  })

  it('applies a request id once and returns current state on retry', async () => {
    const { mutateSaveGameAtomic } = await import('../server/utils/savegame')
    const mutate = vi.fn((save: SaveGame) => {
      save.gold += 100
      return save
    })
    const first = await mutateSaveGameAtomic('atomic-user', 'request-1', mutate)
    const repeated = await mutateSaveGameAtomic('atomic-user', 'request-1', mutate)

    expect(first.gold).toBe(550)
    expect(repeated.gold).toBe(550)
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(document!.processedRequestIds).toContain('request-1')
    expect(document!.revision).toBe(1)
  })

  it('retries a compare-and-swap conflict without applying a partial result', async () => {
    const { mutateSaveGameAtomic } = await import('../server/utils/savegame')
    forcedConflict = true
    const result = await mutateSaveGameAtomic('atomic-user', 'request-2', (save) => {
      save.gold -= 50
      return save
    })
    expect(result.gold).toBe(400)
    expect(document!.gold).toBe(400)
    expect(document!.revision).toBe(1)
  })

  it('serializes concurrent mutations against the save revision', async () => {
    const { mutateSaveGameAtomic } = await import('../server/utils/savegame')
    const [first, second] = await Promise.all([
      mutateSaveGameAtomic('atomic-user', 'concurrent-1', (save) => {
        save.gold -= 20
        return save
      }),
      mutateSaveGameAtomic('atomic-user', 'concurrent-2', (save) => {
        save.gold -= 30
        return save
      })
    ])
    expect([first.gold, second.gold].sort((a, b) => a - b)).toEqual([400, 430])
    expect(document!.gold).toBe(400)
    expect(document!.revision).toBe(2)
    expect(document!.processedRequestIds).toEqual(['concurrent-1', 'concurrent-2'])
  })

  it('initializes concurrent first mutations through one upserted save', async () => {
    const { mutateSaveGameAtomic } = await import('../server/utils/savegame')
    document = undefined
    await Promise.all([
      mutateSaveGameAtomic('new-user', 'new-1', (save) => {
        save.gold -= 20
        return save
      }),
      mutateSaveGameAtomic('new-user', 'new-2', (save) => {
        save.gold -= 30
        return save
      })
    ])
    expect(document!.gold).toBe(400)
    expect(document!.revision).toBe(2)
    expect(new Set(document!.processedRequestIds)).toEqual(new Set(['new-1', 'new-2']))
  })

  it('persists a legacy visitor migration without removing historical data', async () => {
    const { getSaveGame } = await import('../server/utils/savegame')
    const legacyRecord = document as unknown as Record<string, unknown>
    legacyRecord.heroes = [{ id: 'historic-hero', status: 'dead' }]
    delete legacyRecord.visitRound
    delete legacyRecord.visitHistory
    delete legacyRecord.processedRequestIds
    delete legacyRecord.revision

    const migrated = await getSaveGame('atomic-user')
    expect(migrated.visitRound.visitors).toHaveLength(2)
    expect(migrated.heroes).toEqual([{ id: 'historic-hero', status: 'dead' }])
    expect(document!.visitRound.visitors).toHaveLength(2)
    expect(collection.replaceOne).toHaveBeenCalledTimes(1)
  })
})
