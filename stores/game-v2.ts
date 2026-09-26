import { defineStore } from 'pinia'
import type { GameView, UnavailableReason } from '~/shared/types/v2-game-view'
import type { CommandEnvelope, CommandSuccess, PublicApiErrorEnvelope } from '~/shared/types/v2-api-error'
import { useAuthStore } from '~/stores/auth'
import {
  abandonRecoveryPayload,
  acceptContractPayload,
  assignRecoveryPayload,
  confirmSettlementPayload,
  invalidateVisitorV2Selection,
  reconcileGamePayload,
  startExpeditionPayload,
  visitorCycleProjection,
  type VisitorV2Selection
} from '~/utils/v2-visitor-adapter'
import { caravanUpgradePayload, invalidateCaravanSelection, type CaravanSelection } from '~/utils/v2-caravan-adapter'
import {
  equipmentActionPayload,
  invalidateEquipmentSelection,
  itemAction,
  type EquipmentAction,
  type EquipmentSelection
} from '~/utils/v2-equipment-adapter'

type LoadState = 'loading' | 'empty' | 'ready'
type OperationState = 'idle' | 'pending' | 'uncertain' | 'conflict' | 'unavailable' | 'terminal'
type OperationName = 'accept_contract' | 'start_expedition' | 'reconcile_game' | 'confirm_settlement' | 'assign_recovery' | 'abandon_recovery' | 'upgrade_caravan' | EquipmentAction

type PendingOperation = {
  name: OperationName
  endpoint: string
  requestId: string
  expectedRevision: number
  payload: Record<string, unknown>
}

type PendingEquipmentOperation = PendingOperation & { action: EquipmentAction; selection: EquipmentSelection }

export const useGameV2Store = defineStore('game-v2', {
  state: () => ({
    game: null as GameView | null,
    loadState: 'empty' as LoadState,
    operationState: 'idle' as OperationState,
    errorMessage: '',
    unavailableReason: '',
    selection: null as VisitorV2Selection | null,
    caravanSelection: null as CaravanSelection | null,
    equipmentSelection: null as EquipmentSelection | null,
    pendingOperation: null as PendingOperation | null,
    pendingEquipmentOperation: null as PendingEquipmentOperation | null,
    snapshotStale: false,
    reconciledTransitions: {} as Record<string, true>
  }),
  getters: {
    projection: (state) => visitorCycleProjection(state.game),
    isBusy: (state) => state.operationState === 'pending' || state.operationState === 'uncertain'
  },
  actions: {
    applySnapshot(game: GameView) {
      if (this.game && game.revision < this.game.revision) return
      const pendingRevision = this.pendingOperation?.expectedRevision ?? this.pendingEquipmentOperation?.expectedRevision
      if (this.snapshotStale && pendingRevision !== undefined && game.revision <= pendingRevision) {
        this.loadState = this.game ? 'ready' : 'empty'
        this.errorMessage = 'La partida cambió y todavía no terminó de actualizarse. Reintentá la carga.'
        return
      }
      this.game = game
      this.loadState = 'ready'
      if (this.snapshotStale) {
        this.pendingOperation = null
        this.pendingEquipmentOperation = null
      }
      this.snapshotStale = false
      this.selection = invalidateVisitorV2Selection(game, this.selection)
      this.caravanSelection = invalidateCaravanSelection(game, this.caravanSelection)
      this.equipmentSelection = invalidateEquipmentSelection(game, this.equipmentSelection)
    },
    select(selection: VisitorV2Selection | null) {
      this.selection = this.game ? invalidateVisitorV2Selection(this.game, selection) : null
    },
    async load() {
      this.loadState = 'loading'
      this.errorMessage = ''
      try {
        const game = await this.api<GameView>('/api/v2/game')
        this.applySnapshot(game)
      } catch (error) {
        this.loadState = this.game ? 'ready' : 'empty'
        this.errorMessage = publicErrorMessage(error)
      }
    },
    async retryConflictReload() {
      if (!this.snapshotStale) return
      await this.load()
      if (!this.snapshotStale && this.operationState === 'conflict') {
        this.operationState = 'idle'
      }
    },
    async acceptContract(selection: Extract<VisitorV2Selection, { kind: 'contract' }>) {
      if (!this.game) return this.markTerminal()
      if (this.snapshotStale) return false
      await this.runOperation('accept_contract', '/api/v2/contracts/accept', acceptContractPayload(this.game, selection))
    },
    async startExpedition(visitorId: string) {
      if (!this.game) return this.markTerminal()
      if (this.snapshotStale) return false
      await this.runOperation('start_expedition', '/api/v2/expeditions/start', startExpeditionPayload(this.game, visitorId))
    },
    async reconcileGame() {
      if (!this.game) {
        this.markTerminal()
        return false
      }
      return await this.runOperation('reconcile_game', '/api/v2/reconcile', reconcileGamePayload(this.game))
    },
    async confirmSettlement(selection: Extract<VisitorV2Selection, { kind: 'settlement' }>) {
      if (!this.game) return this.markTerminal()
      if (this.snapshotStale) return false
      await this.runOperation('confirm_settlement', '/api/v2/settlements/confirm', confirmSettlementPayload(this.game, selection))
    },
    async assignRecovery(selection: Extract<VisitorV2Selection, { kind: 'recovery' }>) {
      if (!this.game) return this.markTerminal()
      if (this.snapshotStale) return false
      await this.runOperation('assign_recovery', '/api/v2/recoveries/assign', assignRecoveryPayload(this.game, selection))
    },
    async abandonRecovery(selection: Extract<VisitorV2Selection, { kind: 'abandon_recovery' }>) {
      if (!this.game) return this.markTerminal()
      if (this.snapshotStale) return false
      await this.runOperation('abandon_recovery', '/api/v2/recoveries/abandon', abandonRecoveryPayload(this.game, selection))
    },
    selectCaravanUpgrade(selection: CaravanSelection | null) {
      this.caravanSelection = invalidateCaravanSelection(this.game, selection)
    },
    async upgradeCaravan(selection: CaravanSelection) {
      if (!this.game || this.snapshotStale) return false
      try {
        return await this.runOperation('upgrade_caravan', '/api/v2/caravan/upgrade', caravanUpgradePayload(this.game, selection))
      } catch {
        this.caravanSelection = null
        return false
      }
    },
    selectEquipment(selection: EquipmentSelection | null) {
      this.equipmentSelection = invalidateEquipmentSelection(this.game, selection)
    },
    async runEquipmentAction(selection: EquipmentSelection) {
      if (!this.game || this.operationState === 'pending' || this.operationState === 'uncertain' || this.snapshotStale) return false
      const item = this.game.items.find((entry) => entry.itemId === selection.itemId)
      const action = item ? itemAction(item, selection.action) : null
      if (!item || !action || selection.revision !== this.game.revision) {
        this.equipmentSelection = null
        return false
      }
      let payload: Record<string, unknown>
      try {
        payload = equipmentActionPayload(this.game, selection.itemId, action, selection.optionId, selection.acknowledgementId)
      } catch {
        this.equipmentSelection = null
        return false
      }
      const operation: PendingEquipmentOperation = {
        name: selection.action,
        action: selection.action,
        selection,
        endpoint: `/api/v2/actions/${selection.action}`,
        requestId: createRequestId(),
        expectedRevision: this.game.revision,
        payload
      }
      return await this.postEquipmentPending(operation)
    },
    async retryUncertain() {
      if (this.operationState !== 'uncertain') return
      if (this.pendingOperation) await this.postPending(this.pendingOperation)
      else if (this.pendingEquipmentOperation) await this.postEquipmentPending(this.pendingEquipmentOperation)
    },
    async reconcileDueTransition(nowMs = Date.now(), visible = typeof document === 'undefined' || document.visibilityState === 'visible') {
      if (!this.game?.nextTransitionAt || !visible) return
      if (Date.parse(this.game.nextTransitionAt) > nowMs) return
      const key = `${this.game.revision}:${this.game.nextTransitionAt}`
      if (this.reconciledTransitions[key]) return
      if (this.operationState === 'pending' || this.operationState === 'uncertain') return
      this.reconciledTransitions[key] = true
      await this.reconcileGame()
    },
    async runOperation(name: OperationName, endpoint: string, payload: Record<string, unknown>) {
      if (!this.game || this.operationState === 'pending' || this.operationState === 'uncertain' || this.snapshotStale) return false
      const operation = {
        name,
        endpoint,
        requestId: createRequestId(),
        expectedRevision: this.game.revision,
        payload
      }
      return await this.postPending(operation)
    },
    async postPending(operation: PendingOperation) {
      this.pendingOperation = operation
      this.operationState = 'pending'
      this.errorMessage = ''
      this.unavailableReason = ''
      try {
        const response = await this.api<CommandSuccess>(operation.endpoint, {
          method: 'POST',
          body: {
            requestId: operation.requestId,
            expectedRevision: operation.expectedRevision,
            payload: operation.payload
          } satisfies CommandEnvelope<Record<string, unknown>>
        })
        if (operation.name === 'upgrade_caravan' && response.game.revision <= operation.expectedRevision) {
          this.operationState = 'uncertain'
          this.errorMessage = 'La orden no publicó una revisión nueva. Reintentá la misma orden.'
          return false
        }
        this.applySnapshot(response.game)
        this.operationState = 'idle'
        this.pendingOperation = null
        return true
      } catch (error) {
        const parsed = publicApiError(error)
        if (parsed?.error.code === 'uncertain') {
          this.operationState = 'uncertain'
          this.errorMessage = 'No se pudo confirmar el resultado. Reintentá la misma orden.'
          return false
        }
        if (parsed?.error.code === 'revision_conflict') {
          this.operationState = 'conflict'
          this.snapshotStale = true
          this.selection = null
          this.caravanSelection = null
          try {
            const game = await this.api<GameView>('/api/v2/game')
            this.applySnapshot(game)
            if (!this.snapshotStale) this.errorMessage = 'La partida cambió. Revisá las opciones disponibles.'
          } catch (reloadError) {
            this.loadState = this.game ? 'ready' : 'empty'
            this.errorMessage = `La partida cambió, pero no se pudo actualizar. ${publicErrorMessage(reloadError)}`
          }
          return false
        }
        if (parsed?.error.code === 'action_unavailable') {
          this.operationState = 'unavailable'
          this.pendingOperation = null
          this.unavailableReason = parsed.error.reason
          this.errorMessage = publicErrorCopy(parsed.error.code)
          return false
        }
        this.operationState = 'terminal'
        this.pendingOperation = null
        this.errorMessage = publicErrorMessage(error)
        return false
      }
    },
    async postEquipmentPending(operation: PendingEquipmentOperation) {
      this.pendingEquipmentOperation = operation
      this.operationState = 'pending'
      this.errorMessage = ''
      this.unavailableReason = ''
      try {
        const game = await this.api<GameView>(operation.endpoint, {
          method: 'POST',
          body: {
            requestId: operation.requestId,
            expectedRevision: operation.expectedRevision,
            ...operation.payload
          }
        })
        if (game.revision <= operation.expectedRevision) {
          this.operationState = 'uncertain'
          this.errorMessage = 'La orden no publicó una revisión nueva. Reintentá la misma orden.'
          return false
        }
        this.applySnapshot(game)
        this.operationState = 'idle'
        this.pendingEquipmentOperation = null
        return true
      } catch (error) {
        const parsed = publicApiError(error)
        if (parsed?.error.code === 'uncertain') {
          this.operationState = 'uncertain'
          this.errorMessage = 'No se pudo confirmar el resultado. Reintentá la misma orden.'
          return false
        }
        if (parsed?.error.code === 'revision_conflict') {
          this.operationState = 'conflict'
          this.snapshotStale = true
          this.equipmentSelection = null
          return false
        }
        if (parsed?.error.code === 'action_unavailable') {
          this.operationState = 'unavailable'
          this.pendingEquipmentOperation = null
          this.unavailableReason = parsed.error.reason
          this.errorMessage = publicErrorCopy(parsed.error.code)
          return false
        }
        this.operationState = 'terminal'
        this.pendingEquipmentOperation = null
        this.errorMessage = publicErrorMessage(error)
        return false
      }
    },
    async retryEquipmentUncertain() {
      await this.retryUncertain()
    },
    markTerminal() {
      this.operationState = 'terminal'
      this.errorMessage = 'No hay una partida confirmada.'
    },
    async api<T>(url: string, options: Record<string, unknown> = {}): Promise<T> {
      const auth = useAuthStore()
      auth.hydrate()
      const fetcher = $fetch as unknown as (request: string, opts?: Record<string, unknown>) => Promise<unknown>
      try {
        return await authedFetch<T>(fetcher, url, options, auth.accessToken)
      } catch (error) {
        if (isFetchStatus(error, 401) && (await auth.refresh())) {
          return await authedFetch<T>(fetcher, url, options, auth.accessToken)
        }
        throw error
      }
    }
  }
})

async function authedFetch<T>(
  fetcher: (request: string, opts?: Record<string, unknown>) => Promise<unknown>,
  url: string,
  options: Record<string, unknown>,
  token: string
): Promise<T> {
  return await fetcher(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...((options.headers as Record<string, string>) || {})
    }
  }) as T
}

function publicApiError(error: unknown): PublicApiErrorEnvelope | null {
  if (typeof error !== 'object' || !error) return null
  const data = 'data' in error ? (error as { data?: unknown }).data : null
  if (!data || typeof data !== 'object' || !('error' in data)) return null
  const publicError = (data as { error?: Partial<PublicApiErrorEnvelope['error']> }).error
  if (!publicError || typeof publicError.retryable !== 'boolean') return null
  switch (publicError.code) {
    case 'revision_conflict':
      return publicError.retryable === true && validOptionalRequestId(publicError.requestId) ? { error: publicError } as PublicApiErrorEnvelope : null
    case 'idempotency_conflict':
      return publicError.retryable === false && validOptionalRequestId(publicError.requestId) ? { error: publicError } as PublicApiErrorEnvelope : null
    case 'validation_error':
    case 'internal_corruption':
      return publicError.retryable === false ? { error: publicError } as PublicApiErrorEnvelope : null
    case 'action_unavailable':
      return publicError.retryable === false && isUnavailableReason(publicError.reason) && validOptionalRequestId(publicError.requestId)
        ? { error: publicError } as PublicApiErrorEnvelope
        : null
    case 'uncertain':
      return publicError.retryable === true && typeof publicError.requestId === 'string'
        ? { error: publicError } as PublicApiErrorEnvelope
        : null
    case 'internal_error':
      return publicError.retryable === true ? { error: publicError } as PublicApiErrorEnvelope : null
    default:
      return null
  }
}

const unavailableReasons = new Set<UnavailableReason>([
  'VISITOR_NOT_AVAILABLE',
  'EXPEDITION_NOT_READY',
  'MAINTENANCE_DEBT',
  'SERVICE_LOCKED',
  'RECOVERY_LIMIT_REACHED',
  'CAPACITY_FULL',
  'ITEM_IN_USE',
  'ITEM_NOT_OWNED',
  'OPTION_STALE',
  'SETTLEMENT_PENDING',
  'TERMINAL_ENTITY'
])

function isUnavailableReason(value: unknown): value is UnavailableReason {
  return typeof value === 'string' && unavailableReasons.has(value as UnavailableReason)
}

function validOptionalRequestId(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function publicErrorMessage(error: unknown): string {
  const parsed = publicApiError(error)
  if (parsed?.error.code) return publicErrorCopy(parsed.error.code)
  return 'Error inesperado'
}

function publicErrorCopy(code: PublicApiErrorEnvelope['error']['code']): string {
  switch (code) {
    case 'revision_conflict':
      return 'La partida cambió. Volvé a revisar las opciones disponibles.'
    case 'idempotency_conflict':
      return 'La orden no coincide con el intento anterior.'
    case 'action_unavailable':
      return 'La acción ya no está disponible.'
    case 'uncertain':
      return 'No se pudo confirmar el resultado. Reintentá la misma orden.'
    case 'validation_error':
      return 'La orden no pudo validarse.'
    case 'internal_corruption':
    case 'internal_error':
      return 'Error inesperado'
    default:
      return 'Error inesperado'
  }
}

function isFetchStatus(error: unknown, statusCode: number): boolean {
  return Boolean(typeof error === 'object' && error && 'statusCode' in error && (error as { statusCode: number }).statusCode === statusCode)
}

function createRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
