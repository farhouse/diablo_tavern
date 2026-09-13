import { requireUser } from '~/server/utils/auth'
import { requireString } from '~/server/utils/body'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { readVisitorMutation, visitorMutationError, visitorOperationKey } from '~/server/utils/visitor-api'
import { assignVisitorCommission } from '~/utils/visitor-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const visitorId = getRouterParam(event, 'visitorId') || ''
  const body = await readVisitorMutation(event)
  const selection = requireCommissionOptionId(body.optionId)
  try {
    return await mutateSaveGameAtomic(
      user.id,
      body.requestId,
      visitorOperationKey('commission', visitorId, selection),
      body.expectedRevision,
      body,
      (save, deps) => assignVisitorCommission(save, visitorId, selection, deps.random, deps.now())
    )
  } catch (error) {
    visitorMutationError(error, 'Cannot assign commission')
  }
})

function requireCommissionOptionId(value: unknown): 'safe' | 'risky' {
  const optionId = requireString(value, 'optionId')
  if (optionId !== 'safe' && optionId !== 'risky') {
    throw createError({ statusCode: 400, statusMessage: 'optionId must be safe or risky' })
  }
  return optionId
}
