import { beforeEach, describe, expect, it, vi } from 'vitest'

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
})
