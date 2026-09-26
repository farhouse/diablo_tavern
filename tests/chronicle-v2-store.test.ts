import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChronicleV2Store } from '../stores/chronicle-v2'

const hydrate = vi.fn()
const refresh = vi.fn()

vi.mock('../stores/auth', () => ({
  useAuthStore: () => ({ accessToken: 'token', hydrate, refresh })
}))

const first = {
  eventId: 'event-1', occurredAt: '2026-09-26T12:00:00.000Z', type: 'visitor_arrived' as const,
  subject: { kind: 'visitor' as const, id: 'visitor-1' }, text: { key: 'chronicle.visitor_arrived', fallback: 'visitor arrived' }, related: { visitorId: 'visitor-1' }
}
const second = {
  eventId: 'event-2', occurredAt: '2026-09-25T12:00:00.000Z', type: 'item_found' as const,
  subject: { kind: 'item' as const, id: 'item-1' }, text: { key: 'chronicle.item_found', fallback: 'item found' }, related: { itemId: 'item-1' }
}

describe('chronicle V2 store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    hydrate.mockReset()
    refresh.mockReset().mockResolvedValue(false)
  })

  it('uses the opaque cursor and deduplicates incremental pages', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ entries: [first], nextCursor: 'opaque/cursor' })
      .mockResolvedValueOnce({ entries: [first, second], nextCursor: null })
    vi.stubGlobal('$fetch', fetchMock)
    const store = useChronicleV2Store()

    await store.load()
    await store.loadMore()

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v2/chronicle?limit=30',
      '/api/v2/chronicle?limit=30&cursor=opaque%2Fcursor'
    ])
    expect(store.entries.map((entry) => entry.eventId)).toEqual(['event-1', 'event-2'])
    expect(store.hasMore).toBe(false)
  })

  it('keeps existing entries when loading an older page fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ entries: [first], nextCursor: 'next' })
      .mockRejectedValueOnce(new Error('network'))
    vi.stubGlobal('$fetch', fetchMock)
    const store = useChronicleV2Store()

    await store.load()
    await store.loadMore()

    expect(store.entries).toEqual([first])
    expect(store.loadMoreState).toBe('error')
    expect(store.loadMoreError).toContain('siguen disponibles')
  })

  it('ignores an account A response after reset and account B load', async () => {
    let resolveA!: (value: unknown) => void
    const pendingA = new Promise((resolve) => { resolveA = resolve })
    const fetchMock = vi.fn().mockReturnValueOnce(pendingA).mockResolvedValueOnce({ entries: [second], nextCursor: null })
    vi.stubGlobal('$fetch', fetchMock)
    const store = useChronicleV2Store()
    const loadA = store.load()
    store.$reset()
    await store.load()
    resolveA({ entries: [first], nextCursor: 'stale' })
    await loadA
    expect(store.entries).toEqual([second])
    expect(store.nextCursor).toBeNull()
  })

  it('keeps the newest concurrent response when an older request resolves last', async () => {
    let resolveFirst!: (value: unknown) => void
    const firstRequest = new Promise((resolve) => { resolveFirst = resolve })
    const fetchMock = vi.fn().mockReturnValueOnce(firstRequest).mockResolvedValueOnce({ entries: [second], nextCursor: null })
    vi.stubGlobal('$fetch', fetchMock)
    const store = useChronicleV2Store()
    const older = store.load()
    await store.load()
    resolveFirst({ entries: [first], nextCursor: 'stale' })
    await older
    expect(store.entries).toEqual([second])
  })
})
