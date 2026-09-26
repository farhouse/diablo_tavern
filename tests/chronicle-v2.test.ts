import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChronicleV2Store } from '../stores/chronicle-v2'

const refresh = vi.fn().mockResolvedValue(false)
vi.mock('../stores/auth', () => ({ useAuthStore: () => ({ accessToken: 'token', hydrate: vi.fn(), refresh }) }))

const entry = (eventId: string) => ({ eventId, eventKey: eventId, type: 'expedition_started', occurredAt: '2026-09-23T12:00:00Z', subject: { kind: 'expedition', id: eventId }, data: {} })

describe('chronicle V2 store', () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.restoreAllMocks(); refresh.mockClear() })

  it('uses the opaque cursor, deduplicates pages, and preserves entries on incremental error', async () => {
    const store = useChronicleV2Store()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ entries: [entry('a'), entry('a')], nextCursor: 'opaque+/=' })
      .mockRejectedValueOnce(new Error('temporary'))
    vi.stubGlobal('$fetch', fetchMock)

    await store.load()
    expect(store.entries).toHaveLength(1)
    expect(store.nextCursor).toBe('opaque+/=')
    await store.loadMore()

    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v2/chronicle?limit=30&cursor=opaque%2B%2F%3D')
    expect(store.entries).toHaveLength(1)
    expect(store.loadMoreState).toBe('error')
    expect(store.loadMoreError).toContain('siguen disponibles')
  })
})
