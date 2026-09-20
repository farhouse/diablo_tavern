import { requireUser } from '~/server/utils/auth'
import { executeVisitorCycleCommand, readV2Command } from '~/server/utils/v2-command'
import { handleVisitorMutation, requireMutationString } from '~/server/utils/visitor-api'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return handleVisitorMutation(async () => {
    const envelope = await readV2Command(event, ['contractId'])
    const contractId = requireMutationString(envelope.payload.contractId, 'contractId')
    return executeVisitorCycleCommand(user.id, envelope, { action: 'start_expedition', contractId }, ['start', contractId])
  })
})
