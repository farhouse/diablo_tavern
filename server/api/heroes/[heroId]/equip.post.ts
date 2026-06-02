import type { EquipmentSlot } from '~/types/game'
import { requireUser } from '~/server/utils/auth'
import { readRequiredBody, requireString } from '~/server/utils/body'
import { getSaveGame, replaceSaveGame } from '~/server/utils/savegame'
import { equipItem } from '~/utils/game-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const heroId = getRouterParam(event, 'heroId') || ''
  const body = await readRequiredBody(event)
  const itemId = requireString(body.itemId, 'itemId')
  const slot = typeof body.slot === 'string' ? (body.slot as EquipmentSlot) : undefined

  try {
    return replaceSaveGame(equipItem(await getSaveGame(user.id), heroId, itemId, slot))
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : 'Cannot equip item' })
  }
})
