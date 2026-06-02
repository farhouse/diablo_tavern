import { readRequiredBody } from '~/server/utils/body'
import { requireUser } from '~/server/utils/auth'
import { startExpedition } from '~/utils/game-logic'
import { getSaveGame, replaceSaveGame } from '~/server/utils/savegame'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readRequiredBody(event)

  const { questId, heroIds } = body
  const selectedQuestId = typeof questId === 'string' ? questId : ''
  const selectedHeroIds = Array.isArray(heroIds) ? heroIds.filter((id): id is string => typeof id === 'string') : []

  try {
    return replaceSaveGame(startExpedition(await getSaveGame(user.id), selectedQuestId, selectedHeroIds))
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : 'Cannot start expedition' })
  }
})
