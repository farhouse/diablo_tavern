import { requireUser } from '~/server/utils/auth'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { mutationError, operationKey, readMutation } from '~/server/utils/visitor-api'
import { salvageItem } from '~/utils/visitor-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const itemId = getRouterParam(event, 'itemId') || ''
  const body = await readMutation(event)
  try {
    return await mutateSaveGameAtomic(user.id, body.requestId, operationKey('salvage', itemId), (save) => salvageItem(save, itemId))
  } catch (error) {
    mutationError(error, 'Cannot salvage item')
  }
})
