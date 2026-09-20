import { requireUser } from '~/server/utils/auth'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { handleMutation, operationKey, readMutation, requireMutationString } from '~/server/utils/visitor-api'
import { identifyItem } from '~/utils/game-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return handleMutation(async () => {
    const itemId = requireMutationString(getRouterParam(event, 'itemId'), 'itemId')
    const body = await readMutation(event)
    return await mutateSaveGameAtomic(user.id, body.requestId, operationKey('identify', itemId), body.expectedRevision, body, (save, deps) => identifyItem(save, itemId, deps.random, deps.now()))
  })
})
