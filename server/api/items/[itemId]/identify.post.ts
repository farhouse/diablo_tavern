import { requireUser } from '~/server/utils/auth'
import { getSaveGame, replaceSaveGame } from '~/server/utils/savegame'
import { identifyItem } from '~/utils/game-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const itemId = getRouterParam(event, 'itemId') || ''

  try {
    return replaceSaveGame(identifyItem(await getSaveGame(user.id), itemId))
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : 'Cannot identify item' })
  }
})
