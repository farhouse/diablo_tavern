import type { H3Event } from 'h3'
import { readRequiredBody, requireString } from '~/server/utils/body'
import { throwPublicApiError } from '~/server/utils/public-api-error'

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
  void fallback
  return throwPublicApiError(error)
}

export const readMutation = readVisitorMutation
export const operationKey = visitorOperationKey
export const mutationError = visitorMutationError
