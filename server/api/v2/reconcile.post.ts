import { requireUser } from '~/server/utils/auth'
import { executeVisitorCycleCommand, readV2Command } from '~/server/utils/v2-command'
import { handleVisitorMutation } from '~/server/utils/visitor-api'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return handleVisitorMutation(async () => {
    const envelope = await readV2Command(event, [])
    return executeVisitorCycleCommand(user.id, envelope, { action: 'reconcile_game' }, ['reconcile', String(envelope.expectedRevision)])
  })
})
