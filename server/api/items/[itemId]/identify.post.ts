import { requireUser } from '~/server/utils/auth'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { mutationError, operationKey, readMutation } from '~/server/utils/visitor-api'
import { identifyItem } from '~/utils/game-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const itemId = getRouterParam(event, 'itemId') || ''
  const body = await readMutation(event)
  try {
    return await mutateSaveGameAtomic(user.id, body.requestId, operationKey('identify', itemId), body.expectedRevision, body, (save, deps) => identifyItem(save, itemId, deps.random, deps.now()))
  } catch (error) {
    mutationError(error, 'Cannot identify item')
  }
})
