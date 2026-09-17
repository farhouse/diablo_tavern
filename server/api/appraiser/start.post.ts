import { requireUser } from '~/server/utils/auth'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { handleMutation, operationKey, readMutation, requireMutationString } from '~/server/utils/visitor-api'
import { startAppraisal } from '~/utils/game-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return handleMutation(async () => {
    const body = await readMutation(event)
    const itemId = requireMutationString(body.itemId, 'itemId')
    return await mutateSaveGameAtomic(user.id, body.requestId, operationKey('appraise', itemId), body.expectedRevision, body, (save, deps) => startAppraisal(save, itemId, deps.now(), deps.uuid))
  })
})
