import { requireUser } from '~/server/utils/auth'
import { executeVisitorCycleCommand, readV2Command, requireInteger, requireStringArray } from '~/server/utils/v2-command'
import { requireMutationString } from '~/server/utils/visitor-api'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const envelope = await readV2Command(event, ['settlementId', 'previewVersion', 'selectedOptionIds'])
  const settlementId = requireMutationString(envelope.payload.settlementId, 'settlementId')
  const previewVersion = requireInteger(envelope.payload.previewVersion, 'previewVersion')
  const selectedOptionIds = requireStringArray(envelope.payload.selectedOptionIds, 'selectedOptionIds')
  return executeVisitorCycleCommand(user.id, envelope, {
    action: 'confirm_settlement', settlementId, previewVersion, selectedOptionIds
  }, ['settlement', settlementId])
})
