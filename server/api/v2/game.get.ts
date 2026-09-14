import { requireUser } from '~/server/utils/auth'
import { getGameView } from '~/server/domain/game-view'
import { throwPublicApiError } from '~/server/utils/public-api-error'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  try {
    return await getGameView(user.id)
  } catch (error) {
    return throwPublicApiError(error)
  }
})
