import { requireUser } from '~/server/utils/auth'
import { executeVisitorCycleCommand, readV2Command } from '~/server/utils/v2-command'
import { handleVisitorMutation, requireMutationString } from '~/server/utils/visitor-api'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return handleVisitorMutation(async () => {
    const envelope = await readV2Command(event, ['recoveryId', 'acknowledgementId'])
    const recoveryId = requireMutationString(envelope.payload.recoveryId, 'recoveryId')
    const acknowledgementId = requireMutationString(envelope.payload.acknowledgementId, 'acknowledgementId')
    return executeVisitorCycleCommand(user.id, envelope, {
      action: 'abandon_recovery', recoveryId, acknowledgementId
    }, ['recovery-decision', recoveryId])
  })
})
