import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createSaveGame } from '../utils/game-logic'

const hydrate = vi.fn()
vi.mock('../stores/auth', () => ({
  useAuthStore: () => ({ accessToken: 'token', hydrate, refresh: vi.fn().mockResolvedValue(false) })
}))

import { useGameStore } from '../stores/game'

describe('visitor store mutations', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('does not update the save optimistically and blocks a duplicate in-flight mutation', async () => {
    const store = useGameStore()
    const initial = createSaveGame('store-test')
    store.save = initial
    let resolveRequest!: (save: typeof initial) => void
    const response = structuredClone(initial)
    response.gold += 31
    const fetchMock = vi.fn(() => new Promise<typeof initial>((resolve) => { resolveRequest = resolve }))
    vi.stubGlobal('$fetch', fetchMock)

    const before = JSON.parse(JSON.stringify(store.save))
    const first = store.sellToVisitor('visitor-1', 'sword')
    const second = store.buyFromVisitor('visitor-1', 'different-offer')
    expect(store.save).toStrictEqual(before)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(second).resolves.toBeUndefined()

    resolveRequest(response)
    await first
    expect(store.save).toStrictEqual(response)
    expect(store.save.gold).toBe(initial.gold + 31)
  })

  it('reuses the caller request id when an uncertain request is retried', async () => {
    const store = useGameStore()
    store.save = createSaveGame('retry-test')
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('Network disconnected'))
      .mockResolvedValueOnce(store.save)
    vi.stubGlobal('$fetch', fetchMock)

    await expect(store.buyFromVisitor('visitor-1', 'offer-1')).rejects.toThrow('Network disconnected')
    const firstRequestId = fetchMock.mock.calls[0]?.[1]?.body.requestId
    await store.buyFromVisitor('visitor-1', 'offer-1')
    const retryRequestId = fetchMock.mock.calls[1]?.[1]?.body.requestId

    expect(firstRequestId).toBeTruthy()
    expect(retryRequestId).toBe(firstRequestId)
  })

  it('never replaces a newer aggregate with an out-of-order mutation response', async () => {
    const store = useGameStore()
    const initial = createSaveGame('race-test')
    store.save = initial
    let resolveFirst!: (save: typeof initial) => void
    let resolveSecond!: (save: typeof initial) => void
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<typeof initial>((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise<typeof initial>((resolve) => { resolveSecond = resolve }))
    vi.stubGlobal('$fetch', fetchMock)

    const first = store.sellToVisitor('visitor-1', 'sword')
    const second = store.buyFromVisitor('visitor-2', 'offer')
    const revisionTwo = JSON.parse(JSON.stringify(initial))
    revisionTwo.revision = 2
    revisionTwo.gold = 500
    const revisionOne = JSON.parse(JSON.stringify(initial))
    revisionOne.revision = 1
    revisionOne.gold = 470

    resolveSecond(revisionTwo)
    await second
    resolveFirst(revisionOne)
    await first

    expect(store.save.revision).toBe(2)
    expect(store.save.gold).toBe(500)
  })

  it('sends the required commission, claim, and dismiss endpoint payloads', async () => {
    const store = useGameStore()
    store.save = createSaveGame('visitor-actions')
    const fetchMock = vi.fn().mockResolvedValue(store.save)
    vi.stubGlobal('$fetch', fetchMock)

    await store.commissionVisitor('visitor-a', 'blood-moor')
    await store.claimVisitor('visitor-a')
    await store.dismissVisitor('visitor-b')

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/visitors/visitor-a/commission',
      '/api/visitors/visitor-a/claim',
      '/api/visitors/visitor-b/dismiss'
    ])
    expect(fetchMock.mock.calls[0]?.[1]?.body).toMatchObject({ regionId: 'blood-moor' })
    expect(fetchMock.mock.calls.every(([, options]) => Boolean(options.body.requestId))).toBe(true)
  })
})
