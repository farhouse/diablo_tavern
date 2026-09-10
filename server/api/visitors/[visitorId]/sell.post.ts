import { requireUser } from '~/server/utils/auth'
import { requireString } from '~/server/utils/body'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { readVisitorMutation, visitorMutationError } from '~/server/utils/visitor-api'
import { sellToVisitor } from '~/utils/visitor-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const visitorId = getRouterParam(event, 'visitorId') || ''
  const body = await readVisitorMutation(event)
  const itemId = requireString(body.itemId, 'itemId')
  try {
    return await mutateSaveGameAtomic(user.id, body.requestId, (save) => sellToVisitor(save, visitorId, itemId, body.requestId))
  } catch (error) {
    visitorMutationError(error, 'Cannot sell item')
  }
})
