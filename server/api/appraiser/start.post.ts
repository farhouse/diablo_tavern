import { requireUser } from '~/server/utils/auth'
import { requireString } from '~/server/utils/body'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { mutationError, operationKey, readMutation } from '~/server/utils/visitor-api'
import { startAppraisal } from '~/utils/game-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readMutation(event)
  const itemId = requireString(body.itemId, 'itemId')
  try {
    return await mutateSaveGameAtomic(user.id, body.requestId, operationKey('appraise', itemId), body.expectedRevision, body, (save, deps) => startAppraisal(save, itemId, deps.now(), deps.uuid))
  } catch (error) {
    mutationError(error, 'Cannot start appraisal')
  }
})
