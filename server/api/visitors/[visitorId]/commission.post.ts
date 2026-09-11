import { requireUser } from '~/server/utils/auth'
import { requireString } from '~/server/utils/body'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { readVisitorMutation, visitorMutationError, visitorOperationKey } from '~/server/utils/visitor-api'
import { assignVisitorCommission } from '~/utils/visitor-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const visitorId = getRouterParam(event, 'visitorId') || ''
  const body = await readVisitorMutation(event)
  const optionId = requireString(body.optionId, 'optionId')
  try {
    return await mutateSaveGameAtomic(user.id, body.requestId, visitorOperationKey('commission', visitorId, optionId), (save) => assignVisitorCommission(save, visitorId, optionId))
  } catch (error) {
    visitorMutationError(error, 'Cannot assign commission')
  }
})
