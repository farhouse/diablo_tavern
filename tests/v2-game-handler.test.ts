import { beforeEach, describe, expect, it, vi } from 'vitest'

const getGameView = vi.fn()

vi.mock('../server/utils/auth', () => ({
  requireUser: vi.fn(async () => ({ id: 'handler-user' }))
}))
vi.mock('../server/domain/game-view', () => ({ getGameView }))

describe('GET /api/v2/game public errors', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('createError', (definition: Record<string, unknown>) => Object.assign(
      new Error(String(definition.statusMessage)),
      definition
    ))
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('returns a stable sanitized corruption envelope', async () => {
    const { PersistedGameCorruptError } = await import('../server/utils/savegame')
    getGameView.mockRejectedValueOnce(new PersistedGameCorruptError('ledger secret'))
    const { default: handler } = await import('../server/api/v2/game.get')

    await expect(handler({} as never)).rejects.toMatchObject({
      statusCode: 500,
      statusMessage: 'Stored game state is unavailable',
      data: { error: { code: 'internal_corruption', retryable: false } }
    })
  })
})
