import { requireUser } from '~/server/utils/auth'
import { resetSaveGame } from '~/server/utils/savegame'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return resetSaveGame(user.id)
})
