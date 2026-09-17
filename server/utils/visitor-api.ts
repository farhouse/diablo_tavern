import type { H3Event } from 'h3'
import { ActionUnavailableError, V2DomainRuleError, V2ValidationError } from '~/server/domain/v2-errors'
import { throwPublicApiError } from '~/server/utils/public-api-error'

export interface MutationRequestBody {
  requestId: string
  expectedRevision: number
  [key: string]: unknown
}

export async function readVisitorMutation(event: H3Event): Promise<MutationRequestBody> {
  let body: Record<string, unknown> | null | undefined
  try {
    body = await readBody<Record<string, unknown>>(event)
  } catch (error) {
    throw new V2ValidationError('Malformed request body', { cause: error })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new V2ValidationError('Missing request body')
  }
  const requestId = requireMutationString(body.requestId, 'requestId', 128)
  const expectedRevision = requireExpectedRevision(body.expectedRevision)
  return { ...body, requestId, expectedRevision }
}

export function requireMutationString(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new V2ValidationError(`${field} is required`)
  }
  const normalized = value.trim()
  if (normalized.length > maxLength) {
    throw new V2ValidationError(`${field} must be at most ${maxLength} characters`)
  }
  return normalized
}

export function requireMutationEnum<const T extends string>(
  value: unknown,
  field: string,
  values: readonly T[]
): T {
  const normalized = requireMutationString(value, field)
  if (!values.includes(normalized as T)) {
    throw new V2ValidationError(`${field} is invalid`)
  }
  return normalized as T
}

export function visitorOperationKey(operation: string, ...identifiers: string[]): string {
  const key = JSON.stringify([operation, ...identifiers])
  if (key.length > 128) {
    throw new V2ValidationError('Mutation identifiers are too long')
  }
  return key
}

function requireExpectedRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new V2ValidationError('expectedRevision must be a non-negative integer')
  }
  return value
}

export function visitorMutationError(error: unknown, fallback: string): never {
  void fallback
  if (error instanceof V2DomainRuleError && error.unavailableReason) {
    return throwPublicApiError(new ActionUnavailableError(error.unavailableReason, error.message))
  }
  return throwPublicApiError(error)
}

export async function handleVisitorMutation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    return visitorMutationError(error, 'Cannot complete mutation')
  }
}

export const readMutation = readVisitorMutation
export const operationKey = visitorOperationKey
export const mutationError = visitorMutationError
export const handleMutation = handleVisitorMutation
