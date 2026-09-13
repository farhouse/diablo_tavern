import { requireUser } from '~/server/utils/auth'
import { getGameView } from '~/server/domain/game-view'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return getGameView(user.id)
})
