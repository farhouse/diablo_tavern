import type { EquipmentSlot } from '~/types/game'
import { requireUser } from '~/server/utils/auth'
import { readRequiredBody, requireString } from '~/server/utils/body'
import { getSaveGame, replaceSaveGame } from '~/server/utils/savegame'
import { unequipItem } from '~/utils/game-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const heroId = getRouterParam(event, 'heroId') || ''
  const body = await readRequiredBody(event)
  const slot = requireString(body.slot, 'slot') as EquipmentSlot

  try {
    return replaceSaveGame(unequipItem(await getSaveGame(user.id), heroId, slot))
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : 'Cannot unequip item' })
  }
})
