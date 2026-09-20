import { requireUser } from '~/server/utils/auth'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { handleVisitorMutation, readVisitorMutation, requireMutationString, visitorOperationKey } from '~/server/utils/visitor-api'
import { buyFromVisitor } from '~/utils/visitor-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return handleVisitorMutation(async () => {
    const visitorId = requireMutationString(getRouterParam(event, 'visitorId'), 'visitorId')
    const body = await readVisitorMutation(event)
    const offerId = requireMutationString(body.offerId, 'offerId')
    return await mutateSaveGameAtomic(
      user.id,
      body.requestId,
      visitorOperationKey('buy', visitorId, offerId),
      body.expectedRevision,
      body,
      (save, deps) => buyFromVisitor(save, visitorId, offerId, body.requestId, deps.now())
    )
  })
})
