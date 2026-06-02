import { requireUser } from '~/server/utils/auth'
import { advanceExpedition } from '~/utils/game-logic'
import { getSaveGame, replaceSaveGame } from '~/server/utils/savegame'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown> | undefined>(event)
  const expeditionId = typeof body?.expeditionId === 'string' ? body.expeditionId : undefined

  try {
    return replaceSaveGame(advanceExpedition(await getSaveGame(user.id), new Date(), expeditionId))
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : 'Cannot advance expedition' })
  }
})
