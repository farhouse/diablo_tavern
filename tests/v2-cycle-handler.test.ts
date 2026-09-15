import { beforeEach, describe, expect, it, vi } from 'vitest'

const executeVisitorCycleCommand = vi.fn(async () => ({ requestId: 'request-1', revision: 1, game: {} }))

vi.mock('../server/utils/auth', () => ({ requireUser: async () => ({ id: 'v2-handler-user' }) }))
vi.mock('../server/utils/v2-command', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/utils/v2-command')>()
  return { ...original, executeVisitorCycleCommand }
})

describe('V2 command handlers', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  })

  it('accepts only the nested sealed contract payload', async () => {
    vi.stubGlobal('readBody', async () => ({
      requestId: 'request-1', expectedRevision: 0,
      payload: { visitorId: 'visitor-1', optionId: 'option-1', loanItemIds: ['item-1'] }
    }))
    const { default: handler } = await import('../server/api/v2/contracts/accept.post')
    await handler({} as never)
    expect(executeVisitorCycleCommand).toHaveBeenCalledWith(
      'v2-handler-user', expect.objectContaining({ requestId: 'request-1', expectedRevision: 0 }),
      { action: 'accept_contract', visitorId: 'visitor-1', optionId: 'option-1', loanItemIds: ['item-1'] },
      ['contract', 'visitor-1']
    )
  })

  it('rejects economic fields not published by the command contract', async () => {
    vi.stubGlobal('readBody', async () => ({
      requestId: 'request-1', expectedRevision: 0,
      payload: { visitorId: 'visitor-1', optionId: 'option-1', loanItemIds: [], price: 999 }
    }))
    const { default: handler } = await import('../server/api/v2/contracts/accept.post')
    await expect(handler({} as never)).rejects.toMatchObject({ name: 'V2ValidationError' })
    expect(executeVisitorCycleCommand).not.toHaveBeenCalled()
  })

  it('rejects mixed or duplicate settlement selections before persistence', async () => {
    vi.stubGlobal('readBody', async () => ({
      requestId: 'request-1', expectedRevision: 2,
      payload: { settlementId: 'settlement-1', previewVersion: 1, selectedOptionIds: ['same', 'same'] }
    }))
    const { default: handler } = await import('../server/api/v2/settlements/confirm.post')
    await expect(handler({} as never)).rejects.toMatchObject({ name: 'V2ValidationError' })
    expect(executeVisitorCycleCommand).not.toHaveBeenCalled()
  })
})
