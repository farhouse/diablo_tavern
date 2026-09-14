import { requireUser } from '~/server/utils/auth'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { handleVisitorMutation, readVisitorMutation, requireMutationEnum, requireMutationString, visitorOperationKey } from '~/server/utils/visitor-api'
import { assignVisitorCommission } from '~/utils/visitor-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return handleVisitorMutation(async () => {
    const visitorId = requireMutationString(getRouterParam(event, 'visitorId'), 'visitorId')
    const body = await readVisitorMutation(event)
    const selection = requireMutationEnum(body.optionId, 'optionId', ['safe', 'risky'] as const)
    return await mutateSaveGameAtomic(
      user.id,
      body.requestId,
      visitorOperationKey('commission', visitorId, selection),
      body.expectedRevision,
      body,
      (save, deps) => assignVisitorCommission(save, visitorId, selection, deps.random, deps.now())
    )
  })
})
