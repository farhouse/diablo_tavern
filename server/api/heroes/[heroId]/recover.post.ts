import { requireUser } from '~/server/utils/auth'
import { getSaveGame, replaceSaveGame } from '~/server/utils/savegame'
import { recoverHero } from '~/utils/game-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const heroId = getRouterParam(event, 'heroId') || ''

  try {
    return replaceSaveGame(recoverHero(await getSaveGame(user.id), heroId))
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : 'Cannot recover hero' })
  }
})
