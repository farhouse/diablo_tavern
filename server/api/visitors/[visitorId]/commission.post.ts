import { requireUser } from '~/server/utils/auth'
import { requireString } from '~/server/utils/body'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { readVisitorMutation, visitorMutationError, visitorOperationKey } from '~/server/utils/visitor-api'
import { assignVisitorCommission } from '~/utils/visitor-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const visitorId = getRouterParam(event, 'visitorId') || ''
  const body = await readVisitorMutation(event)
  const selection = typeof body.optionId === 'string'
    ? requireString(body.optionId, 'optionId')
    : requireString(body.regionId, 'regionId')
  try {
    return await mutateSaveGameAtomic(user.id, body.requestId, visitorOperationKey('commission', visitorId, selection), (save) => assignVisitorCommission(save, visitorId, selection))
  } catch (error) {
    visitorMutationError(error, 'Cannot assign commission')
  }
})
