import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import fixtures from '../contracts/v2-etapa0-4/fixtures.json'
import type { GameView } from '../shared/types/v2-game-view'
import { useGameV2Store } from '../stores/game-v2'
import { selectionFor } from '../utils/v2-equipment-adapter'

const hydrate = vi.fn()
const refresh = vi.fn()

vi.mock('../stores/auth', () => ({
  useAuthStore: () => ({ accessToken: 'token', hydrate, refresh })
}))

const cases = fixtures.integratedPositiveCases.map((candidate) => ({ id: candidate.id, value: candidate.value as GameView }))

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

  it('blocks competing intentions while uncertain; only retry reuses the envelope', async () => {
    const store = useGameV2Store()
    const game = fixture('integrated-contract')
    const visitor = game.visitors[0]
    if (!visitor || !('contractOptions' in visitor)) throw new Error('Expected contract fixture')
    visitor.contractOptions.push({ ...visitor.contractOptions[0]!, optionId: 'o2' })
    const action = visitor.actions.find((candidate) => candidate.action === 'accept_contract' && candidate.enabled)
    if (!action || action.action !== 'accept_contract' || !action.enabled) throw new Error('Expected accept action')
    action.execution.bindings.push({ optionId: 'o2', eligibleLoanItemIds: ['i1'], expiresAt: '2026-09-15T10:30:00Z' })
    store.applySnapshot(game)
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(apiError({ code: 'uncertain', retryable: true, requestId: 'same' }))
      .mockResolvedValueOnce({ requestId: 'same', revision: 11, game: { ...game, revision: 11 } })
    vi.stubGlobal('$fetch', fetchMock)

    await store.acceptContract({ kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: [] })
    const firstBody = structuredClone(fetchMock.mock.calls[0]?.[1]?.body)
    await store.acceptContract({ kind: 'contract', visitorId: 'v1', optionId: 'o2', loanItemIds: ['i1'] })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await store.retryUncertain()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[1]?.body).toEqual(firstBody)
  })

  it('loads a fresh snapshot after conflict and invalidates stale selection', async () => {
    const store = useGameV2Store()
    store.applySnapshot(fixture('integrated-contract'))
    store.select({ kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: ['i1'] })
    const system = { ...fixture('integrated-system'), revision: 11 }
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

  it('keeps conflict blocked for equal revisions until a newer frontend-only snapshot arrives', async () => {
    const store = useGameV2Store()
    const initial = fixture('integrated-contract')
    const equal = fixture('integrated-system')
    const newer = { ...equal, revision: initial.revision + 1 }
    store.applySnapshot(initial)
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(apiError({ code: 'revision_conflict', retryable: true }))
      .mockResolvedValueOnce(equal)
      .mockResolvedValueOnce(equal)
      .mockResolvedValueOnce(newer)
    vi.stubGlobal('$fetch', fetchMock)

    await store.acceptContract({ kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: [] })
    expect(store.snapshotStale).toBe(true)
    expect(store.operationState).toBe('conflict')
    expect(store.pendingOperation?.expectedRevision).toBe(initial.revision)
    expect(store.game).toEqual(initial)
    expect(store.errorMessage).toContain('Reintentá la carga')

    await store.retryConflictReload()
    expect(store.snapshotStale).toBe(true)
    expect(store.operationState).toBe('conflict')
    expect(store.loadState).toBe('ready')
    await store.acceptContract({ kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: [] })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    await store.retryConflictReload()
    expect(store.snapshotStale).toBe(false)
    expect(store.operationState).toBe('idle')
    expect(store.pendingOperation).toBeNull()
    expect(store.game).toEqual(newer)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v2/contracts/accept', '/api/v2/game', '/api/v2/game', '/api/v2/game'
    ])
  })

  it('keeps conflict honest and retryable when the conflict reload fails', async () => {
    const store = useGameV2Store()
    const initial = fixture('integrated-contract')
    const reloaded = { ...fixture('integrated-system'), revision: 11 }
    store.applySnapshot(initial)
    store.select({ kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: ['i1'] })
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(apiError({ code: 'revision_conflict', retryable: true }))
      .mockRejectedValueOnce({ statusMessage: 'database stack detail' })
      .mockResolvedValueOnce(reloaded)
    vi.stubGlobal('$fetch', fetchMock)

    await store.acceptContract({ kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: ['i1'] })

    expect(store.operationState).toBe('conflict')
    expect(store.snapshotStale).toBe(true)
    expect(store.game).toEqual(initial)
    expect(store.selection).toBeNull()
    expect(store.errorMessage).toContain('no se pudo actualizar')
    expect(store.errorMessage).toContain('Error inesperado')
    expect(store.errorMessage).not.toContain('database stack detail')

    await store.acceptContract({ kind: 'contract', visitorId: 'v1', optionId: 'o1', loanItemIds: [] })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await store.retryConflictReload()

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/v2/contracts/accept', '/api/v2/game', '/api/v2/game'])
    expect(store.operationState).toBe('idle')
    expect(store.snapshotStale).toBe(false)
    expect(store.game).toEqual(reloaded)
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

  it('keeps equipment state unchanged while pending and retries the exact sealed command', async () => {
    const store = useGameV2Store()
    const game = fixture('integrated-destructive')
    const item = game.items.find((entry) => entry.actions.some((action) => action.action === 'dismantle_item' && action.enabled))
    const action = item?.actions.find((entry) => entry.action === 'dismantle_item' && entry.enabled)
    if (!item || !action || !action.enabled || action.action !== 'dismantle_item') throw new Error('Expected irreversible equipment authorization')
    const option = action.execution.options[0]
    if (!option || !('acknowledgement' in option)) throw new Error('Expected acknowledgement token')
    const selection = selectionFor(game, item.itemId, action.action, option.optionId, option.acknowledgement.acknowledgementId)
    if (!selection) throw new Error('Expected sealed equipment selection')
    store.applySnapshot(game)
    const before = JSON.parse(JSON.stringify(store.game))
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(apiError({ code: 'uncertain', retryable: true, requestId: 'same' }))
      .mockResolvedValueOnce(game)
      .mockResolvedValueOnce({ ...game, revision: game.revision + 1 })
    vi.stubGlobal('$fetch', fetchMock)

    await store.runEquipmentAction(selection)
    expect(store.game).toEqual(before)
    expect(store.operationState).toBe('uncertain')
    const firstBody = structuredClone(fetchMock.mock.calls[0]?.[1]?.body)
    await store.retryEquipmentUncertain()
    expect(fetchMock.mock.calls[1]?.[1]?.body).toEqual(firstBody)
    expect(store.operationState).toBe('uncertain')
    await store.retryEquipmentUncertain()
    expect(fetchMock.mock.calls[2]?.[1]?.body).toEqual(firstBody)
    expect(store.operationState).toBe('idle')
    expect(store.game?.revision).toBe(game.revision + 1)
  })

  it('rejects equipment actions from an old revision without posting', async () => {
    const store = useGameV2Store()
    const game = fixture('integrated-services')
    const item = game.items[0]
    if (!item) throw new Error('Expected equipment item')
    const action = item.actions.find((entry) => entry.enabled && entry.action === 'identify_item')
    if (!action || !action.enabled || action.action !== 'identify_item') throw new Error('Expected identify authorization')
    const option = action.execution.options[0]
    if (!option) throw new Error('Expected identify option')
    store.applySnapshot(game)
    const fetchMock = vi.fn()
    vi.stubGlobal('$fetch', fetchMock)
    const accepted = await store.runEquipmentAction({ itemId: item.itemId, action: action.action, optionId: option.optionId, revision: game.revision - 1 })
    expect(accepted).toBe(false)
    expect(store.equipmentSelection).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts only the closed public error union and hides non-public details', async () => {
    const store = useGameV2Store()
    store.applySnapshot(fixture('integrated-recovery'))
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(apiError({ code: 'made_up', retryable: false, statusMessage: 'leak me' }))
      .mockRejectedValueOnce(new Error('raw stack detail'))
      .mockRejectedValueOnce(apiError({ code: 'action_unavailable', retryable: false, reason: 'INTERNAL_ONLY_RULE' }))
    vi.stubGlobal('$fetch', fetchMock)

    await store.assignRecovery({ kind: 'recovery', recoveryId: 'r1', visitorId: 'v2', optionId: 'ro1', loanItemIds: [] })
    expect(store.operationState).toBe('terminal')
    expect(store.errorMessage).toBe('Error inesperado')

    store.operationState = 'idle'
    await store.assignRecovery({ kind: 'recovery', recoveryId: 'r1', visitorId: 'v2', optionId: 'ro1', loanItemIds: [] })
    expect(store.errorMessage).toBe('Error inesperado')

    store.operationState = 'idle'
    await store.assignRecovery({ kind: 'recovery', recoveryId: 'r1', visitorId: 'v2', optionId: 'ro1', loanItemIds: [] })
    expect(store.operationState).toBe('terminal')
    expect(store.unavailableReason).toBe('')
    expect(store.errorMessage).toBe('Error inesperado')
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

  it('does not consume due transition keys while pending or uncertain', async () => {
    const store = useGameV2Store()
    const game = fixture('integrated-system')
    game.nextTransitionAt = '2026-09-14T10:31:00Z'
    store.applySnapshot(game)
    const fetchMock = vi.fn().mockResolvedValue({ requestId: 'r', revision: 10, game })
    vi.stubGlobal('$fetch', fetchMock)

    store.operationState = 'pending'
    await store.reconcileDueTransition(Date.parse('2026-09-14T10:31:01Z'), true)
    store.operationState = 'uncertain'
    await store.reconcileDueTransition(Date.parse('2026-09-14T10:31:02Z'), true)
    expect(fetchMock).not.toHaveBeenCalled()

    store.operationState = 'idle'
    await store.reconcileDueTransition(Date.parse('2026-09-14T10:31:03Z'), true)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('deduplicates a due transition after a failed reconciliation', async () => {
    const store = useGameV2Store()
    const game = fixture('integrated-system')
    game.nextTransitionAt = '2026-09-14T10:31:00Z'
    store.applySnapshot(game)
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ requestId: 'r', revision: 10, game })
    vi.stubGlobal('$fetch', fetchMock)

    await store.reconcileDueTransition(Date.parse('2026-09-14T10:31:01Z'), true)
    await store.reconcileDueTransition(Date.parse('2026-09-14T10:31:02Z'), true)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(store.reconciledTransitions).toHaveProperty(`${game.revision}:${game.nextTransitionAt}`)
  })
})
