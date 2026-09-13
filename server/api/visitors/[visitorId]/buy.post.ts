import { requireUser } from '~/server/utils/auth'
import { requireString } from '~/server/utils/body'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { readVisitorMutation, visitorMutationError, visitorOperationKey } from '~/server/utils/visitor-api'
import { buyFromVisitor } from '~/utils/visitor-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const visitorId = getRouterParam(event, 'visitorId') || ''
  const body = await readVisitorMutation(event)
  const offerId = requireString(body.offerId, 'offerId')
  try {
    return await mutateSaveGameAtomic(
      user.id,
      body.requestId,
      visitorOperationKey('buy', visitorId, offerId),
      body.expectedRevision,
      (save) => buyFromVisitor(save, visitorId, offerId, body.requestId)
    )
  } catch (error) {
    visitorMutationError(error, 'Cannot buy item')
  }
})
