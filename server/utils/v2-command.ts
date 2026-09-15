import type { H3Event } from 'h3'
import type { CommandEnvelope, CommandSuccess } from '~/shared/types/v2-api-error'
import type { VisitorCycleCommand } from '~/server/domain/visitor-cycle'
import { mapPersistedGameToGameView } from '~/server/domain/game-view'
import { V2ValidationError } from '~/server/domain/v2-errors'
import { mutateVisitorCycleAtomic } from '~/server/utils/savegame'
import { handleVisitorMutation, requireMutationString, visitorOperationKey } from '~/server/utils/visitor-api'

export async function readV2Command<T extends Record<string, unknown>>(
  event: H3Event,
  payloadKeys: readonly string[]
): Promise<CommandEnvelope<T>> {
  let body: unknown
  try { body = await readBody(event) } catch (error) {
    throw new V2ValidationError('Malformed request body', { cause: error })
  }
  if (!isRecord(body) || !hasOnlyKeys(body, ['requestId', 'expectedRevision', 'payload'])) {
    throw new V2ValidationError('Command envelope is invalid')
  }
  if (!isRecord(body.payload) || !hasOnlyKeys(body.payload, payloadKeys)) {
    throw new V2ValidationError('Command payload is invalid')
  }
  if (typeof body.expectedRevision !== 'number' || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
    throw new V2ValidationError('expectedRevision must be a non-negative integer')
  }
  return {
    requestId: requireMutationString(body.requestId, 'requestId', 128),
    expectedRevision: body.expectedRevision,
    payload: body.payload as T
  }
}

export function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim()) || new Set(value).size !== value.length) {
    throw new V2ValidationError(`${field} must contain unique non-empty strings`)
  }
  return value.map((entry) => entry.trim())
}

export function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new V2ValidationError(`${field} is invalid`)
  return value
}

export async function executeVisitorCycleCommand(
  userId: string,
  envelope: Pick<CommandEnvelope<Record<string, unknown>>, 'requestId' | 'expectedRevision'>,
  command: VisitorCycleCommand,
  businessIdentifiers: string[]
): Promise<CommandSuccess> {
  return handleVisitorMutation(() => mutateVisitorCycleAtomic(
    userId,
    envelope.requestId,
    envelope.expectedRevision,
    command,
    visitorOperationKey('v2-cycle', ...businessIdentifiers),
    mapPersistedGameToGameView
  ))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}
