import { requireUser } from '~/server/utils/auth'
import { executeVisitorCycleCommand, readV2Command, requireStringArray } from '~/server/utils/v2-command'
import { handleVisitorMutation, requireMutationString } from '~/server/utils/visitor-api'

export default defineEventHandler(async (event) => {
  return handleVisitorMutation(async () => {
    const user = await requireUser(event)
    const envelope = await readV2Command(event, ['recoveryId', 'visitorId', 'optionId', 'loanItemIds'])
    const recoveryId = requireMutationString(envelope.payload.recoveryId, 'recoveryId')
    const visitorId = requireMutationString(envelope.payload.visitorId, 'visitorId')
    const optionId = requireMutationString(envelope.payload.optionId, 'optionId')
    const loanItemIds = requireStringArray(envelope.payload.loanItemIds, 'loanItemIds')
    return executeVisitorCycleCommand(user.id, envelope, {
      action: 'assign_recovery', recoveryId, visitorId, optionId, loanItemIds
    }, ['recovery-decision', recoveryId])
  })
})
