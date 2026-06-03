import { requireUser } from '~/server/utils/auth'
import { readRequiredBody, requireString } from '~/server/utils/body'
import { recallExpedition } from '~/utils/game-logic'
import { getSaveGame, replaceSaveGame } from '~/server/utils/savegame'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readRequiredBody(event)
  const expeditionId = requireString(body.expeditionId, 'expeditionId')
  const usePortal = body.usePortal === true

  try {
    return replaceSaveGame(recallExpedition(await getSaveGame(user.id), expeditionId, undefined, { usePortal }))
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : 'Cannot recall expedition' })
  }
})
