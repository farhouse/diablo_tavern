import { requireUser } from '~/server/utils/auth'
import { transitionItemAtomic } from '~/server/utils/savegame'
import { mutationError, readMutation } from '~/server/utils/visitor-api'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const itemId = getRouterParam(event, 'itemId') || ''
  const body = await readMutation(event)
  try {
    return await transitionItemAtomic(user.id, body.requestId, body.expectedRevision, { operation: 'dismantle', itemId, targetId: `legacy-salvage-${itemId}` })
  } catch (error) {
    mutationError(error, 'Cannot salvage item')
  }
})
