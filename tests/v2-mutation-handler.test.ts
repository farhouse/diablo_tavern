import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SaveGame } from '../types/game'
import { createSaveGame } from '../utils/game-logic'

const { mutateSaveGameAtomic } = vi.hoisted(() => ({ mutateSaveGameAtomic: vi.fn() }))

vi.mock('../server/utils/auth', () => ({
  requireUser: vi.fn(async () => ({ id: 'handler-user' }))
}))
vi.mock('../server/utils/savegame', async (importOriginal) => ({
  ...await importOriginal<typeof import('../server/utils/savegame')>(),
  mutateSaveGameAtomic
}))

describe('V2 mutation handler error contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getRouterParam', () => 'visitor-1')
    vi.stubGlobal('readBody', async () => ({
      requestId: 'request-1', expectedRevision: 7, itemId: 'item-1'
    }))
    vi.stubGlobal('createError', (definition: Record<string, unknown>) => Object.assign(
      new Error(String(definition.statusMessage)),
      definition
    ))
  })

  it('emits discriminated conflicts, unavailability, and uncertain results from a real handler', async () => {
    const { ActionUnavailableError, UncertainOperationError } = await import('../server/domain/v2-errors')
    const { IdempotencyConflictError, RevisionConflictError } = await import('../server/utils/savegame')
    const { default: handler } = await import('../server/api/visitors/[visitorId]/sell.post')
    const cases = [
      [new RevisionConflictError('private revision'), 409, { code: 'revision_conflict', retryable: true }],
      [new IdempotencyConflictError('private hash'), 409, { code: 'idempotency_conflict', retryable: false }],
      [new ActionUnavailableError('ITEM_IN_USE'), 409, { code: 'action_unavailable', retryable: false, reason: 'ITEM_IN_USE' }],
      [new UncertainOperationError('request-1'), 503, { code: 'uncertain', retryable: true, requestId: 'request-1' }]
    ] as const

    for (const [source, statusCode, error] of cases) {
      mutateSaveGameAtomic.mockRejectedValueOnce(source)
      await expect(handler({} as never)).rejects.toMatchObject({
        statusCode,
        data: { error }
      })
    }
  })

  it.each([
    ['missing body', undefined],
    ['empty requestId', { requestId: '', expectedRevision: 7, itemId: 'item-1' }],
    ['long requestId', { requestId: 'x'.repeat(129), expectedRevision: 7, itemId: 'item-1' }],
    ['missing revision', { requestId: 'request-1', itemId: 'item-1' }],
    ['fractional revision', { requestId: 'request-1', expectedRevision: 1.5, itemId: 'item-1' }],
    ['negative revision', { requestId: 'request-1', expectedRevision: -1, itemId: 'item-1' }],
    ['missing required field', { requestId: 'request-1', expectedRevision: 7 }]
  ])('returns the stable validation envelope for %s', async (_label, body) => {
    vi.stubGlobal('readBody', async () => body)
    const { default: handler } = await import('../server/api/visitors/[visitorId]/sell.post')

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: 'The request is invalid',
      data: { error: { code: 'validation_error', retryable: false } }
    })
    expect(mutateSaveGameAtomic).not.toHaveBeenCalled()
  })

  it('returns the stable validation envelope for a malformed body', async () => {
    vi.stubGlobal('readBody', async () => { throw new SyntaxError('private parser detail') })
    const { default: handler } = await import('../server/api/visitors/[visitorId]/sell.post')

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: 'The request is invalid',
      data: { error: { code: 'validation_error', retryable: false } }
    })
  })

  it('returns validation_error before persistence when identifiers make the operation key too long', async () => {
    vi.stubGlobal('getRouterParam', () => 'v'.repeat(120))
    vi.stubGlobal('readBody', async () => ({
      requestId: 'request-1', expectedRevision: 7, itemId: 'item-1'
    }))
    const { default: handler } = await import('../server/api/visitors/[visitorId]/sell.post')

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 400,
      data: { error: { code: 'validation_error', retryable: false } }
    })
    expect(mutateSaveGameAtomic).not.toHaveBeenCalled()
  })

  it.each([
    ['commission option', '../server/api/visitors/[visitorId]/commission.post', { requestId: 'request-1', expectedRevision: 7, optionId: 'reckless' }],
    ['caravan upgrade', '../server/api/caravan/upgrade.post', { requestId: 'request-1', expectedRevision: 7, upgradeId: 'castle' }]
  ])('returns the stable validation envelope for an invalid %s enum', async (_label, modulePath, body) => {
    vi.stubGlobal('readBody', async () => body)
    const { default: handler } = modulePath.includes('commission')
      ? await import('../server/api/visitors/[visitorId]/commission.post')
      : await import('../server/api/caravan/upgrade.post')

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 400,
      data: { error: { code: 'validation_error', retryable: false } }
    })
    expect(mutateSaveGameAtomic).not.toHaveBeenCalled()
  })

  it('maps a real visitor rule to action_unavailable with its authoritative reason', async () => {
    const save = createSaveGame('handler-user')
    const visitor = save.visitRound.slots.find((slot) => slot.visitor)?.visitor
    if (!visitor) throw new Error('Expected visitor fixture')
    visitor.id = 'visitor-1'
    vi.stubGlobal('readBody', async () => ({
      requestId: 'request-real-rule', expectedRevision: 0, itemId: 'missing-item'
    }))
    mutateSaveGameAtomic.mockImplementationOnce(async (...args: unknown[]) => {
      const mutate = args[5] as (draft: SaveGame, dependencies: { now: () => Date }) => SaveGame
      return mutate(save, { now: () => new Date('2026-09-14T00:00:00.000Z') })
    })
    const { default: handler } = await import('../server/api/visitors/[visitorId]/sell.post')

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 409,
      data: { error: { code: 'action_unavailable', retryable: false, reason: 'ITEM_NOT_OWNED' } }
    })
  })

  it('maps an already-consumed real trade to OPTION_STALE', async () => {
    const save = createSaveGame('handler-user')
    const visitor = save.visitRound.slots.find((slot) => slot.visitor)?.visitor
    const item = save.stash[0]
    if (!visitor || !item) throw new Error('Expected visitor and item fixtures')
    visitor.id = 'visitor-1'
    visitor.trades.push({
      requestId: 'earlier', kind: 'player_sold', itemId: item.id, price: 1,
      createdAt: '2026-09-14T00:00:00.000Z'
    })
    vi.stubGlobal('readBody', async () => ({
      requestId: 'request-stale-trade', expectedRevision: 0, itemId: item.id
    }))
    mutateSaveGameAtomic.mockImplementationOnce(async (...args: unknown[]) => {
      const mutate = args[5] as (draft: SaveGame, dependencies: { now: () => Date }) => SaveGame
      return mutate(save, { now: () => new Date('2026-09-14T00:00:00.000Z') })
    })
    const { default: handler } = await import('../server/api/visitors/[visitorId]/sell.post')

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 409,
      data: { error: { code: 'action_unavailable', retryable: false, reason: 'OPTION_STALE' } }
    })
  })
})
