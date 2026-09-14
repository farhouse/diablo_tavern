import { requireUser } from '~/server/utils/auth'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { handleVisitorMutation, readVisitorMutation, requireMutationString, visitorOperationKey } from '~/server/utils/visitor-api'
import { claimVisitorCommission } from '~/utils/visitor-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return handleVisitorMutation(async () => {
    const visitorId = requireMutationString(getRouterParam(event, 'visitorId'), 'visitorId')
    const body = await readVisitorMutation(event)
    return await mutateSaveGameAtomic(
      user.id,
      body.requestId,
      visitorOperationKey('claim', visitorId),
      body.expectedRevision,
      body,
      (save, deps) => claimVisitorCommission(save, visitorId, deps.now())
    )
  })
})
