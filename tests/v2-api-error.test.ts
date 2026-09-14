import { describe, expect, it } from 'vitest'
import { ActionUnavailableError, UncertainOperationError } from '../server/domain/v2-errors'
import { toPublicApiError } from '../server/utils/public-api-error'
import {
  IdempotencyConflictError,
  PersistedGameCorruptError,
  RevisionConflictError
} from '../server/utils/savegame'

describe('V2 public error envelope', () => {
  it.each([
    [new RevisionConflictError('sensitive revision detail'), 409, { code: 'revision_conflict', retryable: true }, 'sensitive revision detail'],
    [new IdempotencyConflictError('sensitive hash detail'), 409, { code: 'idempotency_conflict', retryable: false }, 'sensitive hash detail'],
    [new ActionUnavailableError('ITEM_IN_USE', 'internal rule detail'), 409, { code: 'action_unavailable', retryable: false, reason: 'ITEM_IN_USE' }, 'internal rule detail'],
    [new UncertainOperationError('request-123'), 503, { code: 'uncertain', retryable: true, requestId: 'request-123' }, null],
    [new PersistedGameCorruptError('ledger and business-key detail'), 500, { code: 'internal_corruption', retryable: false }, 'ledger and business-key detail']
  ] as const)('maps %s without exposing internal exception messages', (source, statusCode, error, secret) => {
    const result = toPublicApiError(source)
    expect(result.statusCode).toBe(statusCode)
    expect(result.data).toEqual({ error })
    if (secret) expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('sanitizes unknown internal failures into a stable retryable envelope', () => {
    const result = toPublicApiError(new Error('mongodb://secret-host/private-db'))
    expect(result).toEqual({
      statusCode: 500,
      statusMessage: 'The game service could not complete the request',
      data: { error: { code: 'internal_error', retryable: true } }
    })
  })
})
