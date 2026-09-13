import type { H3Event } from 'h3'
import { readRequiredBody, requireString } from '~/server/utils/body'
import { VisitorDomainError } from '~/utils/visitor-logic'
import { BusinessKeyConflictError, IdempotencyConflictError, RevisionConflictError } from '~/server/utils/savegame'

export interface MutationRequestBody {
  requestId: string
  expectedRevision: number
  [key: string]: unknown
}

export async function readVisitorMutation(event: H3Event): Promise<MutationRequestBody> {
  const body = await readRequiredBody(event)
  const requestId = requireString(body.requestId, 'requestId')
  if (requestId.length > 128) throw createError({ statusCode: 400, statusMessage: 'requestId must be at most 128 characters' })
  const expectedRevision = requireExpectedRevision(body.expectedRevision)
  return { ...body, requestId, expectedRevision }
}

export function visitorOperationKey(operation: string, ...identifiers: string[]): string {
  return JSON.stringify([operation, ...identifiers])
}

function requireExpectedRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw createError({ statusCode: 400, statusMessage: 'expectedRevision must be a non-negative integer' })
  }
  return value
}

export function visitorMutationError(error: unknown, fallback: string): never {
  if (error instanceof VisitorDomainError || (error instanceof Error && error.name === 'GameDomainError')) {
    throw createError({ statusCode: 400, statusMessage: error.message })
  }
  if (error instanceof IdempotencyConflictError) throw createError({ statusCode: 409, statusMessage: error.message })
  if (error instanceof BusinessKeyConflictError) throw createError({ statusCode: 409, statusMessage: error.message })
  if (error instanceof RevisionConflictError) throw createError({ statusCode: 409, statusMessage: error.message })
  if (error instanceof Error && error.message.includes('concurrently')) {
    throw createError({ statusCode: 409, statusMessage: error.message })
  }
  console.error('Unexpected visitor mutation failure', error)
  throw createError({ statusCode: 500, statusMessage: fallback })
}

export const readMutation = readVisitorMutation
export const operationKey = visitorOperationKey
export const mutationError = visitorMutationError
