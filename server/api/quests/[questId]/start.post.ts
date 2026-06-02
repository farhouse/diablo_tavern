import { requireUser } from '~/server/utils/auth'
import { readRequiredBody } from '~/server/utils/body'
import { getSaveGame, replaceSaveGame } from '~/server/utils/savegame'
import { startQuest } from '~/utils/game-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const questId = getRouterParam(event, 'questId') || ''
  const body = await readRequiredBody(event)
  const heroIds = Array.isArray(body.heroIds) ? body.heroIds.filter((id): id is string => typeof id === 'string') : []

  try {
    return replaceSaveGame(startQuest(await getSaveGame(user.id), questId, heroIds))
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : 'Cannot start quest' })
  }
})
