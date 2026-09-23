import { requireUser } from '~/server/utils/auth'
import { mapPersistedGameToGameView } from '~/server/domain/game-view'
import { mutateCaravanUpgradeAtomic } from '~/server/utils/savegame'
import { readV2Command } from '~/server/utils/v2-command'
import { handleVisitorMutation, requireMutationString } from '~/server/utils/visitor-api'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return handleVisitorMutation(async () => {
    const envelope = await readV2Command<{ optionId: string }>(event, ['optionId'])
    const optionId = requireMutationString(envelope.payload.optionId, 'optionId', 512)
    return mutateCaravanUpgradeAtomic(user.id, envelope.requestId, envelope.expectedRevision, optionId, mapPersistedGameToGameView)
  })
})
