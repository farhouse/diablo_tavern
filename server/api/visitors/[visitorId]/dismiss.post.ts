import { requireUser } from '~/server/utils/auth'
import { mutateSaveGameAtomic } from '~/server/utils/savegame'
import { readVisitorMutation, visitorMutationError } from '~/server/utils/visitor-api'
import { dismissVisitor } from '~/utils/visitor-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const visitorId = getRouterParam(event, 'visitorId') || ''
  const body = await readVisitorMutation(event)
  try {
    return await mutateSaveGameAtomic(user.id, body.requestId, (save) => dismissVisitor(save, visitorId))
  } catch (error) {
    visitorMutationError(error, 'Cannot dismiss visitor')
  }
})
