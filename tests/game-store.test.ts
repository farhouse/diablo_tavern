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
    const second = store.sellToVisitor('visitor-1', 'sword')
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
})
