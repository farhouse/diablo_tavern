import { requireUser } from '~/server/utils/auth'
import { getSaveGame, serializeSave } from '~/server/utils/savegame'
import { normalizeSaveGame } from '~/utils/game-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const save = serializeSave(await getSaveGame(user.id))
  return normalizeSaveGame(save)
})
