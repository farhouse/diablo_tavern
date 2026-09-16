import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import fixtures from '../contracts/v2-etapa0-3/fixtures.json'
import type { GameView } from '../shared/types/v2-game-view'
import { useGameV2Store } from '../stores/game-v2'

const hydrate = vi.fn()
const refresh = vi.fn()

vi.mock('../stores/auth', () => ({
  useAuthStore: () => ({ accessToken: 'token', hydrate, refresh })
}))

const cases = fixtures.integratedPositiveCases as Array<{ id: string, value: GameView }>

function fixture(id: string): GameView {
  const match = cases.find((candidate) => candidate.id === id)
  if (!match) throw new Error(`Missing fixture ${id}`)
  return structuredClone(match.value)
}

function apiError(error: unknown) {
  return { data: { error } }
}

describe('game V2 store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    hydrate.mockReset()
    refresh.mockReset().mockResolvedValue(false)
  })

  it('applies snapshots monotonically and does not mutate optimistically', async () => {
    const store = useGameV2Store()
    const initial = fixture('integrated-contract')
    const newer = fixture('integrated-contract')
    newer.revision = 12
    const older = fixture('integrated-contract')
    older.revision = 11
    store.applySnapshot(initial)

    let resolveRequest!: (response: unknown) => void
    const fetchMock = vi.fn(() => new Promise((resolve) => { resolveRequest = resolve }))
    vi.stubGlobal('$fetch', fetchMock)

    const before = JSON.parse(JSON.stringify(store.game))
    const pending = store.acceptContract({ kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: [] })
    expect(store.game).toEqual(before)
    expect(store.operationState).toBe('pending')

    store.applySnapshot(newer)
    resolveRequest({ requestId: 'r1', revision: older.revision, game: older })
    await pending

    expect(store.game?.revision).toBe(12)
  })

  it('reuses the exact envelope after an uncertain operation', async () => {
    const store = useGameV2Store()
    store.applySnapshot(fixture('integrated-expedition'))
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(apiError({ code: 'uncertain', retryable: true, requestId: 'same' }))
      .mockResolvedValueOnce({ requestId: 'same', revision: 11, game: { ...fixture('integrated-expedition'), revision: 11 } })
    vi.stubGlobal('$fetch', fetchMock)

    await store.startExpedition('v1')
    const firstBody = structuredClone(fetchMock.mock.calls[0]?.[1]?.body)
    expect(store.operationState).toBe('uncertain')
    await store.retryUncertain()

    expect(fetchMock.mock.calls[1]?.[1]?.body).toEqual(firstBody)
    expect(store.operationState).toBe('idle')
  })

  it('loads a fresh snapshot after conflict and invalidates stale selection', async () => {
    const store = useGameV2Store()
    store.applySnapshot(fixture('integrated-contract'))
    store.select({ kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: ['i1'] })
    const system = fixture('integrated-system')
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(apiError({ code: 'revision_conflict', retryable: true }))
      .mockResolvedValueOnce(system)
    vi.stubGlobal('$fetch', fetchMock)

    await store.acceptContract({ kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: ['i1'] })

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/v2/contracts/accept', '/api/v2/game'])
    expect(store.operationState).toBe('conflict')
    expect(store.selection).toBeNull()
    expect(store.game).toEqual(system)
  })

  it('keeps confirmed snapshot for unavailable and terminal errors', async () => {
    const store = useGameV2Store()
    const initial = fixture('integrated-recovery')
    store.applySnapshot(initial)
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(apiError({
      code: 'action_unavailable',
      retryable: false,
      reason: 'RECOVERY_LIMIT_REACHED'
    })))

    await store.assignRecovery({ kind: 'recovery', recoveryId: 'r1', visitorId: 'v2', optionId: 'ro1', loanItemIds: [] })

    expect(store.game).toEqual(initial)
    expect(store.operationState).toBe('unavailable')
    expect(store.unavailableReason).toBe('RECOVERY_LIMIT_REACHED')
  })

  it('reconciles a due transition once per revision and transition while visible', async () => {
    const store = useGameV2Store()
    const game = fixture('integrated-system')
    game.nextTransitionAt = '2026-09-14T10:31:00Z'
    store.applySnapshot(game)
    const fetchMock = vi.fn().mockResolvedValue({ requestId: 'r', revision: 10, game })
    vi.stubGlobal('$fetch', fetchMock)

    await store.reconcileDueTransition(Date.parse('2026-09-14T10:31:01Z'), false)
    await store.reconcileDueTransition(Date.parse('2026-09-14T10:31:01Z'), true)
    await store.reconcileDueTransition(Date.parse('2026-09-14T10:31:02Z'), true)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v2/reconcile')
  })
})
