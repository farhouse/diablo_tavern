import type { CaravanUpgradeId } from '~/types/game'
import { requireUser } from '~/server/utils/auth'
import { readRequiredBody, requireString } from '~/server/utils/body'
import { getSaveGame, replaceSaveGame } from '~/server/utils/savegame'
import { touchSave, normalizeSaveGame, upgradeCaravan } from '~/utils/game-logic'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readRequiredBody(event)
  const upgradeId = requireString(body.upgradeId, 'upgradeId') as CaravanUpgradeId
  const validUpgrades: CaravanUpgradeId[] = ['wagons', 'scoutTable', 'stashWagon', 'infirmary', 'appraiser']
  if (!validUpgrades.includes(upgradeId)) throw createError({ statusCode: 400, statusMessage: 'Invalid upgrade' })

  try {
    let save = normalizeSaveGame(await getSaveGame(user.id))
    save = upgradeCaravan(save, upgradeId)
    return replaceSaveGame(touchSave(save))
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : 'Cannot upgrade' })
  }
})