import { requireUser } from '~/server/utils/auth'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { handleMutation, operationKey, readMutation } from '~/server/utils/visitor-api'
import { createSaveGame } from '~/utils/game-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return handleMutation(async () => {
    const body = await readMutation(event)
    return await mutateSaveGameAtomic(user.id, body.requestId, operationKey('reset'), body.expectedRevision, body, (_save, deps) => createSaveGame(user.id, deps.now(), deps.random))
  })
})
