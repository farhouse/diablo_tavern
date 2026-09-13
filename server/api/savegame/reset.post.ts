import { requireUser } from '~/server/utils/auth'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { mutationError, operationKey, readMutation } from '~/server/utils/visitor-api'
import { createSaveGame } from '~/utils/game-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readMutation(event)
  try {
    return await mutateSaveGameAtomic(user.id, body.requestId, operationKey('reset'), body.expectedRevision, body, (_save, deps) => createSaveGame(user.id, deps.now(), deps.random))
  } catch (error) {
    mutationError(error, 'Cannot reset save')
  }
})
