import { requireUser } from '~/server/utils/auth'
import { ActionUnavailableError } from '~/server/domain/v2-errors'
import { handleVisitorMutation, readVisitorMutation, requireMutationString } from '~/server/utils/visitor-api'

export default defineEventHandler(async (event) => {
  await requireUser(event)
  return handleVisitorMutation(async () => {
    requireMutationString(getRouterParam(event, 'visitorId'), 'visitorId')
    await readVisitorMutation(event)
    throw new ActionUnavailableError('TERMINAL_ENTITY', 'Legacy commission claims were replaced by V2 settlements')
  })
})
