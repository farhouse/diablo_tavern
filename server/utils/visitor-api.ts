import type { H3Event } from 'h3'
import { createHash } from 'node:crypto'
import { readRequiredBody, requireString } from '~/server/utils/body'
import { VisitorDomainError } from '~/utils/visitor-logic'
import { IdempotencyConflictError } from '~/server/utils/savegame'

export async function readVisitorMutation(event: H3Event): Promise<Record<string, unknown> & { requestId: string }> {
  const body = await readRequiredBody(event)
  const requestId = requireString(body.requestId, 'requestId')
  if (requestId.length > 128) throw createError({ statusCode: 400, statusMessage: 'requestId must be at most 128 characters' })
  return { ...body, requestId }
}

export function visitorOperationKey(operation: string, ...identifiers: string[]): string {
  return createHash('sha256').update(JSON.stringify([operation, ...identifiers])).digest('hex')
}

export function visitorMutationError(error: unknown, fallback: string): never {
  if (error instanceof VisitorDomainError) throw createError({ statusCode: 400, statusMessage: error.message })
  if (error instanceof IdempotencyConflictError) throw createError({ statusCode: 409, statusMessage: error.message })
  if (error instanceof Error && error.message.includes('concurrently')) {
    throw createError({ statusCode: 409, statusMessage: error.message })
  }
  console.error('Unexpected visitor mutation failure', error)
  throw createError({ statusCode: 500, statusMessage: fallback })
}
