import { requireUser } from '~/server/utils/auth'
import { ActionUnavailableError } from '~/server/domain/v2-errors'
import { handleVisitorMutation, readVisitorMutation, requireMutationEnum, requireMutationString } from '~/server/utils/visitor-api'

export default defineEventHandler(async (event) => {
  await requireUser(event)
  return handleVisitorMutation(async () => {
    requireMutationString(getRouterParam(event, 'visitorId'), 'visitorId')
    const body = await readVisitorMutation(event)
    requireMutationEnum(body.optionId, 'optionId', ['safe', 'risky'] as const)
    throw new ActionUnavailableError('TERMINAL_ENTITY', 'Legacy commissions were replaced by V2 contracts')
  })
})
