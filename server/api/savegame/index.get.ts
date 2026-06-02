import { requireUser } from '~/server/utils/auth'
import { getSaveGame, serializeSave } from '~/server/utils/savegame'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return serializeSave(await getSaveGame(user.id))
})
