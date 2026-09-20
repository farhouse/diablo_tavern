import { requireUser } from '~/server/utils/auth'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { handleVisitorMutation, readVisitorMutation, requireMutationString, visitorOperationKey } from '~/server/utils/visitor-api'
import { sellToVisitor } from '~/utils/visitor-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return handleVisitorMutation(async () => {
    const visitorId = requireMutationString(getRouterParam(event, 'visitorId'), 'visitorId')
    const body = await readVisitorMutation(event)
    const itemId = requireMutationString(body.itemId, 'itemId')
    return await mutateSaveGameAtomic(
      user.id,
      body.requestId,
      visitorOperationKey('sell', visitorId, itemId),
      body.expectedRevision,
      body,
      (save, deps) => sellToVisitor(save, visitorId, itemId, body.requestId, deps.now())
    )
  })
})
