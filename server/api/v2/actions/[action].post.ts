import type { EquipmentV2Action, EquipmentV2Command } from '~/server/domain/equipment-v2'
import { mapPersistedGameToGameView } from '~/server/domain/game-view'
import { requireUser } from '~/server/utils/auth'
import { readRequiredBody, requireString } from '~/server/utils/body'
import { mutateEquipmentV2Atomic, RevisionConflictError, IdempotencyConflictError, BusinessKeyConflictError } from '~/server/utils/savegame'
import { EquipmentV2Error } from '~/server/domain/equipment-v2'

const ITEM_ACTIONS = new Set<EquipmentV2Action>([
  'identify_item',
  'queue_blacksmith_job',
  'queue_enchanter_job',
  'dismantle_item',
  'replace_boss_imprint'
])

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const action = getRouterParam(event, 'action') as EquipmentV2Action
  if (!ITEM_ACTIONS.has(action)) throw createError({ statusCode: 404, statusMessage: 'Unknown V2 action' })

  const body = await readRequiredBody(event)
  const allowed = action === 'dismantle_item' || action === 'replace_boss_imprint'
    ? ['requestId', 'expectedRevision', 'itemId', 'optionId', 'acknowledgementId']
    : ['requestId', 'expectedRevision', 'itemId', 'optionId']
  rejectUnknownFields(body, allowed)

  const command: EquipmentV2Command = {
    action,
    itemId: requireString(body.itemId, 'itemId'),
    optionId: requireString(body.optionId, 'optionId'),
    ...(body.acknowledgementId !== undefined ? { acknowledgementId: requireString(body.acknowledgementId, 'acknowledgementId') } : {})
  }
  try {
    const persisted = await mutateEquipmentV2Atomic(
      user.id,
      requireString(body.requestId, 'requestId'),
      requireExpectedRevision(body.expectedRevision),
      command
    )
    return mapPersistedGameToGameView(persisted)
  } catch (error) {
    mutationError(error)
  }
})

function rejectUnknownFields(body: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(body).find((key) => !allowedSet.has(key))
  if (unknown) throw createError({ statusCode: 400, statusMessage: `Unexpected field: ${unknown}` })
}

function requireExpectedRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw createError({ statusCode: 400, statusMessage: 'expectedRevision must be a non-negative integer' })
  }
  return value
}

function mutationError(error: unknown): never {
  if (error instanceof EquipmentV2Error) throw createError({ statusCode: 400, statusMessage: error.message })
  if (error instanceof IdempotencyConflictError) throw createError({ statusCode: 409, statusMessage: error.message })
  if (error instanceof BusinessKeyConflictError) throw createError({ statusCode: 409, statusMessage: error.message })
  if (error instanceof RevisionConflictError) throw createError({ statusCode: 409, statusMessage: error.message })
  console.error('Unexpected V2 equipment mutation failure', error)
  throw createError({ statusCode: 500, statusMessage: 'Cannot apply V2 equipment action' })
}
