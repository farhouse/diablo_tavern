import { requireUser } from '~/server/utils/auth'
import { executeVisitorCycleCommand, readV2Command, requireStringArray } from '~/server/utils/v2-command'
import { requireMutationString } from '~/server/utils/visitor-api'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const envelope = await readV2Command(event, ['visitorId', 'optionId', 'loanItemIds'])
  const visitorId = requireMutationString(envelope.payload.visitorId, 'visitorId')
  const optionId = requireMutationString(envelope.payload.optionId, 'optionId')
  const loanItemIds = requireStringArray(envelope.payload.loanItemIds, 'loanItemIds')
  return executeVisitorCycleCommand(user.id, envelope, {
    action: 'accept_contract', visitorId, optionId, loanItemIds
  }, ['contract', visitorId])
})
