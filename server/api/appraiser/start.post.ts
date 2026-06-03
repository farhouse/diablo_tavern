import { requireUser } from '~/server/utils/auth'
import { readRequiredBody, requireString } from '~/server/utils/body'
import { getSaveGame, replaceSaveGame } from '~/server/utils/savegame'
import { touchSave, normalizeSaveGame, startAppraisal } from '~/utils/game-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readRequiredBody(event)
  const itemId = requireString(body.itemId, 'itemId')

  try {
    let save = normalizeSaveGame(await getSaveGame(user.id))
    save = startAppraisal(save, itemId)
    return replaceSaveGame(touchSave(save))
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : 'Cannot start appraisal' })
  }
})