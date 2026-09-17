import type { UnavailableReason } from './v2-game-view.generated'
import type { GameView } from './v2-game-view.generated'

export interface CommandEnvelope<T> {
  requestId: string
  expectedRevision: number
  payload: T
}

export interface CommandSuccess {
  requestId: string
  revision: number
  game: GameView
}

export type PublicApiError =
  | { code: 'revision_conflict'; retryable: true; requestId?: string }
  | { code: 'idempotency_conflict'; retryable: false; requestId?: string }
  | { code: 'action_unavailable'; retryable: false; reason: UnavailableReason; requestId?: string }
  | { code: 'uncertain'; retryable: true; requestId: string }
  | { code: 'validation_error'; retryable: false }
  | { code: 'internal_corruption'; retryable: false }
  | { code: 'internal_error'; retryable: true }

export interface PublicApiErrorEnvelope {
  error: PublicApiError
}
