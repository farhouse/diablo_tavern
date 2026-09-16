import { defineStore } from 'pinia'
import type { GameView } from '~/shared/types/v2-game-view'
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

type LoadState = 'loading' | 'empty' | 'ready'
type OperationState = 'idle' | 'pending' | 'uncertain' | 'conflict' | 'unavailable' | 'terminal'
type OperationName = 'accept_contract' | 'start_expedition' | 'reconcile_game' | 'confirm_settlement' | 'assign_recovery' | 'abandon_recovery'

type PendingOperation = {
  name: OperationName
  endpoint: string
  requestId: string
  expectedRevision: number
  payload: Record<string, unknown>
}

export const useGameV2Store = defineStore('game-v2', {
  state: () => ({
    game: null as GameView | null,
    loadState: 'empty' as LoadState,
    operationState: 'idle' as OperationState,
    errorMessage: '',
    unavailableReason: '',
    selection: null as VisitorV2Selection | null,
    pendingOperation: null as PendingOperation | null,
    reconciledTransitions: {} as Record<string, true>
  }),
  getters: {
    projection: (state) => visitorCycleProjection(state.game),
    isBusy: (state) => state.operationState === 'pending'
  },
  actions: {
    applySnapshot(game: GameView) {
      if (this.game && game.revision < this.game.revision) return
      this.game = game
      this.loadState = 'ready'
      this.selection = invalidateVisitorV2Selection(game, this.selection)
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
    async acceptContract(selection: Extract<VisitorV2Selection, { kind: 'contract' }>) {
      if (!this.game) return this.markTerminal()
      await this.runOperation('accept_contract', '/api/v2/contracts/accept', acceptContractPayload(this.game, selection))
    },
    async startExpedition(visitorId: string) {
      if (!this.game) return this.markTerminal()
      await this.runOperation('start_expedition', '/api/v2/expeditions/start', startExpeditionPayload(this.game, visitorId))
    },
    async reconcileGame() {
      if (!this.game) return this.markTerminal()
      await this.runOperation('reconcile_game', '/api/v2/reconcile', reconcileGamePayload(this.game))
    },
    async confirmSettlement(selection: Extract<VisitorV2Selection, { kind: 'settlement' }>) {
      if (!this.game) return this.markTerminal()
      await this.runOperation('confirm_settlement', '/api/v2/settlements/confirm', confirmSettlementPayload(this.game, selection))
    },
    async assignRecovery(selection: Extract<VisitorV2Selection, { kind: 'recovery' }>) {
      if (!this.game) return this.markTerminal()
      await this.runOperation('assign_recovery', '/api/v2/recoveries/assign', assignRecoveryPayload(this.game, selection))
    },
    async abandonRecovery(selection: Extract<VisitorV2Selection, { kind: 'abandon_recovery' }>) {
      if (!this.game) return this.markTerminal()
      await this.runOperation('abandon_recovery', '/api/v2/recoveries/abandon', abandonRecoveryPayload(this.game, selection))
    },
    async retryUncertain() {
      if (!this.pendingOperation || this.operationState !== 'uncertain') return
      await this.postPending(this.pendingOperation)
    },
    async reconcileDueTransition(nowMs = Date.now(), visible = typeof document === 'undefined' || document.visibilityState === 'visible') {
      if (!this.game?.nextTransitionAt || !visible) return
      if (Date.parse(this.game.nextTransitionAt) > nowMs) return
      const key = `${this.game.revision}:${this.game.nextTransitionAt}`
      if (this.reconciledTransitions[key]) return
      this.reconciledTransitions[key] = true
      await this.reconcileGame()
    },
    async runOperation(name: OperationName, endpoint: string, payload: Record<string, unknown>) {
      if (!this.game || this.operationState === 'pending') return
      const operation = this.pendingOperation && this.pendingOperation.name === name && this.operationState === 'uncertain'
        ? this.pendingOperation
        : {
            name,
            endpoint,
            requestId: createRequestId(),
            expectedRevision: this.game.revision,
            payload
          }
      await this.postPending(operation)
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
        this.applySnapshot(response.game)
        this.operationState = 'idle'
        this.pendingOperation = null
      } catch (error) {
        const parsed = publicApiError(error)
        if (parsed?.error.code === 'uncertain') {
          this.operationState = 'uncertain'
          this.errorMessage = 'No se pudo confirmar el resultado. Reintentá la misma orden.'
          return
        }
        if (parsed?.error.code === 'revision_conflict') {
          this.operationState = 'conflict'
          this.pendingOperation = null
          await this.load()
          this.errorMessage = 'La partida cambió. Revisá las opciones disponibles.'
          return
        }
        if (parsed?.error.code === 'action_unavailable') {
          this.operationState = 'unavailable'
          this.pendingOperation = null
          this.unavailableReason = parsed.error.reason
          this.errorMessage = parsed.error.reason
          return
        }
        this.operationState = 'terminal'
        this.pendingOperation = null
        this.errorMessage = publicErrorMessage(error)
      }
    },
    markTerminal() {
      this.operationState = 'terminal'
      this.errorMessage = 'No hay snapshot V2 confirmado.'
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
  const envelope = data as PublicApiErrorEnvelope
  return typeof envelope.error?.code === 'string' && typeof envelope.error.retryable === 'boolean' ? envelope : null
}

function publicErrorMessage(error: unknown): string {
  const parsed = publicApiError(error)
  if (parsed?.error.code) return parsed.error.code
  if (typeof error === 'object' && error && 'statusMessage' in error) return String((error as { statusMessage: string }).statusMessage)
  if (error instanceof Error) return error.message
  return 'Error inesperado'
}

function isFetchStatus(error: unknown, statusCode: number): boolean {
  return Boolean(typeof error === 'object' && error && 'statusCode' in error && (error as { statusCode: number }).statusCode === statusCode)
}

function createRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
