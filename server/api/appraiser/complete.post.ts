import { requireUser } from '~/server/utils/auth'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { handleMutation, operationKey, readMutation } from '~/server/utils/visitor-api'
import { completeAppraisalQueue } from '~/utils/game-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return handleMutation(async () => {
    const body = await readMutation(event)
    return await mutateSaveGameAtomic(user.id, body.requestId, operationKey('appraise-complete'), body.expectedRevision, body, (save, deps) => completeAppraisalQueue(save, deps.now(), deps.random))
  })
})
