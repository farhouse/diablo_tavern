import type { PublicApiError, PublicApiErrorEnvelope } from '~/shared/types/v2-api-error'
import { ActionUnavailableError, UncertainOperationError, V2ValidationError } from '~/server/domain/v2-errors'
import {
  BusinessKeyConflictError,
  IdempotencyConflictError,
  PersistedGameCorruptError,
  RevisionConflictError
} from '~/server/utils/savegame'

export interface PublicApiErrorDefinition {
  statusCode: number
  statusMessage: string
  data: PublicApiErrorEnvelope
}

export function toPublicApiError(error: unknown): PublicApiErrorDefinition {
  if (error instanceof RevisionConflictError) {
    return definition(409, 'Game state changed; reload before retrying', {
      code: 'revision_conflict', retryable: true
    })
  }
  if (error instanceof IdempotencyConflictError || error instanceof BusinessKeyConflictError) {
    return definition(409, 'The request conflicts with an operation already recorded', {
      code: 'idempotency_conflict', retryable: false
    })
  }
  if (error instanceof ActionUnavailableError) {
    return definition(409, 'The requested action is unavailable', {
      code: 'action_unavailable', retryable: false, reason: error.reason,
      ...(error.requestId ? { requestId: error.requestId } : {})
    })
  }
  if (error instanceof UncertainOperationError) {
    return definition(503, 'The operation result is uncertain; retry with the same requestId', {
      code: 'uncertain', retryable: true, requestId: error.requestId
    })
  }
  if (error instanceof PersistedGameCorruptError) {
    return definition(500, 'Stored game state is unavailable', {
      code: 'internal_corruption', retryable: false
    })
  }
  if (error instanceof V2ValidationError || (error instanceof Error && error.name === 'V2ValidationError')) {
    return definition(400, 'The request is invalid', {
      code: 'validation_error', retryable: false
    })
  }
  if (isClientDomainError(error)) {
    return definition(400, error.message, {
      code: 'validation_error', retryable: false
    })
  }
  return definition(500, 'The game service could not complete the request', {
    code: 'internal_error', retryable: true
  })
}

export function throwPublicApiError(error: unknown): never {
  const mapped = toPublicApiError(error)
  if (mapped.statusCode >= 500 && !(error instanceof UncertainOperationError)) {
    console.error('V2 API request failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
  }
  throw createError(mapped)
}

function definition(statusCode: number, statusMessage: string, error: PublicApiError): PublicApiErrorDefinition {
  return { statusCode, statusMessage, data: { error } }
}

function isClientDomainError(error: unknown): error is Error {
  return error instanceof Error && [
    'VisitorDomainError',
    'GameDomainError',
    'ItemTransitionError'
  ].includes(error.name)
}
