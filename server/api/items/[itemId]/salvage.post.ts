import { requireUser } from '~/server/utils/auth'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { handleMutation, operationKey, readMutation, requireMutationString } from '~/server/utils/visitor-api'
import { salvageItem } from '~/utils/visitor-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return handleMutation(async () => {
    const itemId = requireMutationString(getRouterParam(event, 'itemId'), 'itemId')
    const body = await readMutation(event)
    return await mutateSaveGameAtomic(user.id, body.requestId, operationKey('salvage', itemId), body.expectedRevision, body, (save, deps) => salvageItem(save, itemId, deps.now()))
  })
})
