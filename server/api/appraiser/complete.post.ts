import { requireUser } from '~/server/utils/auth'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { mutationError, operationKey, readMutation } from '~/server/utils/visitor-api'
import { completeAppraisalQueue } from '~/utils/game-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readMutation(event)
  try {
    return await mutateSaveGameAtomic(user.id, body.requestId, operationKey('appraise-complete'), body.expectedRevision, (save) => completeAppraisalQueue(save))
  } catch (error) {
    mutationError(error, 'Cannot complete appraisal')
  }
})
