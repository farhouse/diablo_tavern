import { requireUser } from '~/server/utils/auth'
import { getSaveGame, replaceSaveGame } from '~/server/utils/savegame'
import { touchSave, normalizeSaveGame, completeAppraisalQueue } from '~/utils/game-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)

  try {
    let save = normalizeSaveGame(await getSaveGame(user.id))
    save = completeAppraisalQueue(save)
    return replaceSaveGame(touchSave(save))
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : 'Cannot complete appraisal' })
  }
})