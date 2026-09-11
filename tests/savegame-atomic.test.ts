import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SaveGame } from '../types/game'
import { createSaveGame } from '../utils/game-logic'

let document: SaveGame | undefined
let forcedConflict = false

const visitors = (save: SaveGame) => save.visitRound.slots.flatMap((slot) => slot.visitor ? [slot.visitor] : [])

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
    const first = await mutateSaveGameAtomic('atomic-user', 'request-1', 'buy:visitor-1:offer-1', mutate)
    const repeated = await mutateSaveGameAtomic('atomic-user', 'request-1', 'buy:visitor-1:offer-1', mutate)

    expect(first.gold).toBe(550)
    expect(repeated.gold).toBe(550)
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(document!.processedRequestIds).toContain('request-1')
    expect(document!.revision).toBe(1)
  })

  it('rejects reuse of a persisted request id for a different command', async () => {
    const { mutateSaveGameAtomic } = await import('../server/utils/savegame')
    await mutateSaveGameAtomic('atomic-user', 'request-reused', 'buy:visitor-1:offer-1', (save) => {
      save.gold -= 10
    })

    await expect(mutateSaveGameAtomic('atomic-user', 'request-reused', 'sell:visitor-2:item-1', (save) => {
      save.gold += 500
    })).rejects.toThrow('requestId was already used for a different operation')
    expect(document!.gold).toBe(440)
  })

  it('retries a compare-and-swap conflict without applying a partial result', async () => {
    const { mutateSaveGameAtomic } = await import('../server/utils/savegame')
    forcedConflict = true
    const result = await mutateSaveGameAtomic('atomic-user', 'request-2', 'test:request-2', (save) => {
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
      mutateSaveGameAtomic('atomic-user', 'concurrent-1', 'test:concurrent-1', (save) => {
        save.gold -= 20
        return save
      }),
      mutateSaveGameAtomic('atomic-user', 'concurrent-2', 'test:concurrent-2', (save) => {
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
      mutateSaveGameAtomic('new-user', 'new-1', 'test:new-1', (save) => {
        save.gold -= 20
        return save
      }),
      mutateSaveGameAtomic('new-user', 'new-2', 'test:new-2', (save) => {
        save.gold -= 30
        return save
      })
    ])
    expect(document!.gold).toBe(400)
    expect(document!.revision).toBe(2)
    expect(new Set(document!.processedRequestIds)).toEqual(new Set(['new-1', 'new-2']))
  })

  it('persists a legacy visitor migration without removing historical data', async () => {
    const { getSaveGame, mutateSaveGameAtomic } = await import('../server/utils/savegame')
    const legacyRecord = document as unknown as Record<string, unknown>
    legacyRecord.heroes = [{ id: 'historic-hero', status: 'dead' }]
    legacyRecord.processedRequestIds = ['legacy-request']
    delete legacyRecord.visitRound
    delete legacyRecord.visitHistory
    delete legacyRecord.processedRequests
    delete legacyRecord.revision

    const migrated = await getSaveGame('atomic-user')
    expect(visitors(migrated)).toHaveLength(2)
    expect(migrated.heroes).toEqual([{ id: 'historic-hero', status: 'dead' }])
    expect(visitors(document!)).toHaveLength(2)
    expect(document!.processedRequests).toEqual([{ requestId: 'legacy-request', operationKey: '' }])
    expect(collection.replaceOne).toHaveBeenCalledTimes(1)

    const mutate = vi.fn()
    await mutateSaveGameAtomic('atomic-user', 'legacy-request', 'new-fingerprint', mutate)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('migrates the legacy visitor array into two persisted slots', async () => {
    const { getSaveGame } = await import('../server/utils/savegame')
    const legacyRound = document!.visitRound as unknown as { slots?: unknown; visitors?: unknown }
    const legacyVisitors = visitors(document!)
    legacyVisitors[0]!.state = 'departed'
    legacyVisitors[0]!.departedAt = '2030-01-01T00:00:00.000Z'
    const departedId = legacyVisitors[0]!.id
    legacyRound.visitors = legacyVisitors
    delete legacyRound.slots

    const migrated = await getSaveGame('atomic-user')

    expect(migrated.visitRound.slots).toHaveLength(2)
    expect(visitors(migrated)).toHaveLength(1)
    expect(document!.visitRound.slots).toHaveLength(2)
    expect(document!.visitHistory[0]!.slots.some((slot) => slot.visitor?.id === departedId)).toBe(true)
    expect(document!.visitRound.slots.find((slot) => !slot.visitor)!.nextArrivalCheckAt).toBeTruthy()
    expect('visitors' in (document!.visitRound as unknown as Record<string, unknown>)).toBe(false)
  })

  it('persists a freed slot schedule once across an idempotent retry', async () => {
    const { mutateSaveGameAtomic } = await import('../server/utils/savegame')
    const { dismissVisitor } = await import('../utils/visitor-logic')
    const visitorId = visitors(document!)[0]!.id
    const operation = `dismiss:${visitorId}`

    const first = await mutateSaveGameAtomic('atomic-user', 'dismiss-once', operation, (save) => {
      dismissVisitor(save, visitorId, new Date('2030-01-01T00:00:00.000Z'))
    })
    const scheduledAt = first.visitRound.slots.find((slot) => !slot.visitor)!.nextArrivalCheckAt
    const repeated = await mutateSaveGameAtomic('atomic-user', 'dismiss-once', operation, (save) => {
      dismissVisitor(save, visitorId, new Date('2030-01-01T00:00:00.000Z'))
    })

    expect(scheduledAt).toBe('2030-01-01T00:00:30.000Z')
    expect(repeated.visitRound.slots.find((slot) => !slot.visitor)!.nextArrivalCheckAt).toBe(scheduledAt)
    expect(document!.revision).toBe(1)
  })

  it('persists a due probabilistic arrival with CAS retry', async () => {
    const { getSaveGame } = await import('../server/utils/savegame')
    const slot = document!.visitRound.slots[0]!
    delete slot.visitor
    slot.nextArrivalCheckAt = '2020-01-01T00:00:00.000Z'
    forcedConflict = true
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)

    const loaded = await getSaveGame('atomic-user')

    expect(loaded.visitRound.slots[0]!.visitor).toBeDefined()
    expect(document!.visitRound.slots[0]!.visitor).toBeDefined()
    expect(document!.visitRound.slots[0]!.nextArrivalCheckAt).toBeUndefined()
    expect(document!.revision).toBe(1)
    expect(collection.replaceOne).toHaveBeenCalledTimes(2)
    random.mockRestore()
  })

  it('persists missing visitor origin and equipment summary during read migration', async () => {
    const { getSaveGame } = await import('../server/utils/savegame')
    const visitor = visitors(document!)[0]!
    visitor.power += 11
    delete (visitor as Partial<typeof visitor>).origin
    delete (visitor as Partial<typeof visitor>).equipmentSummary

    const migrated = await getSaveGame('atomic-user')
    const persistedVisitor = visitors(document!)[0]!

    expect(visitors(migrated)[0]!.origin).toBeTruthy()
    expect(persistedVisitor.origin).toBe(visitors(migrated)[0]!.origin)
    expect(persistedVisitor.equipmentSummary).toEqual(visitors(migrated)[0]!.equipmentSummary)
    expect(persistedVisitor.equipmentSummary).toContainEqual(expect.objectContaining({ powerBonus: 11 }))
    expect(collection.replaceOne).toHaveBeenCalledTimes(1)
  })

  it('persists visitor detail migration in history after a compare-and-swap retry', async () => {
    const { getSaveGame } = await import('../server/utils/savegame')
    const historicalRound = structuredClone(document!.visitRound)
    historicalRound.id = 'legacy-history-round'
    const historicalVisitor = historicalRound.slots[0]!.visitor!
    historicalVisitor.power += 9
    historicalVisitor.state = 'departed'
    historicalVisitor.departedAt = '2025-01-01T00:00:00.000Z'
    delete (historicalVisitor as Partial<typeof historicalVisitor>).origin
    delete (historicalVisitor as Partial<typeof historicalVisitor>).equipmentSummary
    document!.visitHistory = [historicalRound]
    forcedConflict = true

    const migrated = await getSaveGame('atomic-user')
    const migratedVisitor = migrated.visitHistory[0]!.slots[0]!.visitor!
    const persistedVisitor = document!.visitHistory[0]!.slots[0]!.visitor!

    expect(migratedVisitor.origin).toBeTruthy()
    expect(persistedVisitor.origin).toBe(migratedVisitor.origin)
    expect(persistedVisitor.state).toBe('departed')
    expect(persistedVisitor.equipmentSummary).toContainEqual(expect.objectContaining({ powerBonus: 9 }))
    expect(document!.revision).toBe(1)
    expect(collection.replaceOne).toHaveBeenCalledTimes(2)
  })

  it('persists a completed commission transition observed by a read', async () => {
    const { getSaveGame } = await import('../server/utils/savegame')
    const visitor = visitors(document!)[0]!
    visitor.state = 'commissioned'
    visitor.commission = {
      ...visitor.commissionOptions[0]!,
      id: 'commission-1',
      status: 'active',
      startedAt: '2020-01-01T00:00:00.000Z',
      finishesAt: '2020-01-01T00:01:00.000Z',
      outcomeRoll: 0
    }
    forcedConflict = true

    const loaded = await getSaveGame('atomic-user')

    expect(visitors(loaded)[0]!.state).toBe('returned')
    expect(visitors(document!)[0]!.state).toBe('returned')
    expect(visitors(document!)[0]!.commission!.status).toBe('ready')
    expect(document!.revision).toBe(1)
    expect(collection.replaceOne).toHaveBeenCalledTimes(2)
  })

  it('maps an idempotency fingerprint conflict to HTTP 409', async () => {
    const createError = vi.fn((details: { statusCode: number; statusMessage: string }) => Object.assign(new Error(details.statusMessage), details))
    vi.stubGlobal('createError', createError)
    const { IdempotencyConflictError } = await import('../server/utils/savegame')
    const { visitorMutationError } = await import('../server/utils/visitor-api')

    expect(() => visitorMutationError(new IdempotencyConflictError('requestId conflict'), 'fallback'))
      .toThrow(expect.objectContaining({ statusCode: 409, message: 'requestId conflict' }))
    expect(createError).toHaveBeenCalledWith({ statusCode: 409, statusMessage: 'requestId conflict' })
  })
})
