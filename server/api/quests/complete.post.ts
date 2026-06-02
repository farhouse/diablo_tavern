import { requireUser } from '~/server/utils/auth'
import { getSaveGame, replaceSaveGame } from '~/server/utils/savegame'
import { completeActiveQuest } from '~/utils/game-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)

  try {
    return replaceSaveGame(completeActiveQuest(await getSaveGame(user.id)))
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : 'Cannot complete quest' })
  }
})
